import type { PrivateQuestion } from '../quiz/quiz.types';
import type { QuizRepository } from '../quiz/quiz.repository';
import { isAllOfTheAbove } from './all-of-the-above';
import { shuffleArrayInPlace, type RandomSource } from './assessment.random';
import {
  AssessmentBuildError,
  CUSTOM_QUESTION_COUNTS,
  DURATION_SECONDS_BY_COUNT,
  INTERVIEW_DIFFICULTIES,
  type CustomQuestionCount,
  type GeneratedInterviewSnapshot,
  type GeneratedOptionSnapshot,
  type GeneratedQuestionSnapshot,
  type InterviewBuildConfig,
  type InterviewBuildRequest,
  type InterviewDifficulty
} from './assessment.types';

/**
 * Backend port of Angular's `AssessmentBuilderService.build()` (the CUSTOM
 * path). Pure: no Express, no SQLite, no filesystem, no tokens, no DTOs.
 * Deterministic under a deterministic RandomSource.
 *
 * PORTED FAITHFULLY from
 * src/app/shared/services/features/assessment/assessment-builder.service.ts:
 *
 *   - topic ids are de-duplicated, order preserved
 *   - per-topic pools are cloned from the catalog, never referenced
 *   - allocate(): even split, remainder to the FIRST topics in the given order,
 *     each capped by that topic's capacity, then leftovers redistributed
 *     round-robin to topics with spare capacity  (3 topics / 20 → 7,7,6)
 *   - per-topic shuffle, then take the first N
 *   - a final shuffle of the combined selection
 *   - per-question option shuffle with "All of the above" pinned last AFTER
 *     shuffling
 *   - duration from DURATION_SECONDS_BY_COUNT
 *
 * DELIBERATE DIVERGENCES (each is a tightening the user asked for; the Angular
 * behaviour is noted so the difference is never mistaken for an accident):
 *
 *   1. UNKNOWN TOPIC IDS ARE REJECTED. Angular's `findQuiz(id)` returns
 *      undefined for an unknown id, yielding an empty pool that silently
 *      contributes zero capacity — a typo just makes the interview smaller or
 *      throws a confusing "insufficient questions". Here it is an explicit
 *      UNKNOWN_TOPIC error.
 *   2. TOPIC/DIFFICULTY CONSISTENCY IS ENFORCED. Angular's `build()` ignores
 *      `config.difficulty` entirely — filtering happens earlier, in
 *      `eligibleTopicIds()`, which only the UI calls. A caller could therefore
 *      request difficulty 'beginner' with advanced-only topics and get them.
 *      Here that is TOPIC_DIFFICULTY_MISMATCH.
 *   3. QUESTION TYPE IS CARRIED EXPLICITLY. Source questions have no `type`
 *      field, so Angular's generated questions leave it undefined and every
 *      consumer re-derives it by counting correct options. The backend copies
 *      the repository's derived type, which is what lets the active DTO omit
 *      correctness entirely.
 */

// ── validation ──────────────────────────────────────────────────────

function fail(code: AssessmentBuildError['code'], message: string): never {
  throw new AssessmentBuildError(code, message);
}

function dedupe(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Validate and normalize a raw request.
 *
 * Difficulty is normalized HERE and nowhere else — one boundary, one canonical
 * lowercase value, matching quiz.json ('beginner' | 'intermediate' |
 * 'advanced') plus the Interview-only 'mixed'.
 */
export function validateBuildRequest(
  request: InterviewBuildRequest,
  repository: QuizRepository
): InterviewBuildConfig {
  const rawDifficulty = request.difficulty;
  if (typeof rawDifficulty !== 'string' || rawDifficulty.trim().length === 0) {
    fail('INVALID_CONFIG', 'difficulty is required');
  }
  const difficulty = rawDifficulty.trim().toLowerCase() as InterviewDifficulty;
  if (!INTERVIEW_DIFFICULTIES.includes(difficulty)) {
    fail('INVALID_CONFIG', `unsupported difficulty "${difficulty}"`);
  }

  const rawTopics = request.topicIds;
  if (!Array.isArray(rawTopics)) {
    fail('INVALID_CONFIG', 'topicIds must be an array');
  }
  if (rawTopics.length === 0) {
    fail('INVALID_CONFIG', 'at least one topic must be selected');
  }
  if (!rawTopics.every((id): id is string => typeof id === 'string' && id.trim().length > 0)) {
    fail('INVALID_CONFIG', 'every topic id must be a non-empty string');
  }

  const trimmed = rawTopics.map((id) => id.trim());
  const topicIds = dedupe(trimmed);
  if (topicIds.length !== trimmed.length) {
    // Angular silently de-duplicates. Rejecting is louder and cannot mask a
    // client bug that would otherwise halve a topic's representation.
    fail('INVALID_CONFIG', 'topicIds contains duplicates');
  }

  for (const topicId of topicIds) {
    const quiz = repository.getQuizById(topicId);
    if (!quiz) fail('UNKNOWN_TOPIC', `unknown topic "${topicId}"`);
    if (difficulty !== 'mixed' && quiz.difficulty !== difficulty) {
      fail(
        'TOPIC_DIFFICULTY_MISMATCH',
        `topic "${topicId}" is not available at difficulty "${difficulty}"`
      );
    }
  }

  const rawCount = request.questionCount;
  if (typeof rawCount !== 'number' || !Number.isInteger(rawCount)) {
    fail('INVALID_CONFIG', 'questionCount must be an integer');
  }
  if (!CUSTOM_QUESTION_COUNTS.includes(rawCount as CustomQuestionCount)) {
    fail(
      'INVALID_CONFIG',
      `questionCount must be one of ${CUSTOM_QUESTION_COUNTS.join(', ')} — received ${rawCount}`
    );
  }
  const questionCount = rawCount as CustomQuestionCount;

  const available = topicIds.reduce(
    (sum, id) => sum + (repository.getQuizById(id)?.questions.length ?? 0),
    0
  );
  if (available < questionCount) {
    fail(
      'INSUFFICIENT_QUESTIONS',
      `only ${available} questions available for ${questionCount} requested`
    );
  }

  return {
    difficulty,
    topicIds,
    questionCount,
    // Derived, never caller-supplied: the stored duration is always the one
    // that will actually be enforced.
    durationSeconds: DURATION_SECONDS_BY_COUNT[questionCount]
  };
}

// ── allocation ──────────────────────────────────────────────────────

/**
 * EXACT port of Angular's `allocate()`.
 *
 * Even split; the remainder goes to the FIRST topics in the caller's order
 * (not randomly); every target is capped by that topic's capacity; anything
 * still unassigned is handed out round-robin to topics with spare capacity.
 *
 * 20 across 3 topics → base 6, remainder 2 → 7, 7, 6.
 */
export function allocate(
  topicIds: readonly string[],
  capacityById: ReadonlyMap<string, number>,
  count: number
): Map<string, number> {
  const alloc = new Map(topicIds.map((id) => [id, 0]));

  const base = Math.floor(count / topicIds.length);
  const remainder = count % topicIds.length;

  for (const [index, id] of topicIds.entries()) {
    const target = base + (index < remainder ? 1 : 0);
    alloc.set(id, Math.min(target, capacityById.get(id) ?? 0));
  }

  let assigned = [...alloc.values()].reduce((a, b) => a + b, 0);
  while (assigned < count) {
    const spare = topicIds.filter((id) => (capacityById.get(id) ?? 0) - (alloc.get(id) ?? 0) > 0);
    if (spare.length === 0) break;   // unreachable once availability is checked
    for (const id of spare) {
      if (assigned >= count) break;
      alloc.set(id, (alloc.get(id) ?? 0) + 1);
      assigned++;
    }
  }

  return alloc;
}

// ── option ordering ─────────────────────────────────────────────────

/**
 * Shuffle a question's options, then pin "All of the above" last — the same
 * order of operations as Angular's `shuffleOptions()`. `displayOrder` is
 * re-stamped from the final position; `optionId` never changes.
 */
export function orderOptions(
  question: PrivateQuestion,
  random: RandomSource
): GeneratedOptionSnapshot[] {
  const shuffled = shuffleArrayInPlace([...question.options], random);
  const pinned = pinAllOfTheAboveLast(shuffled);

  return pinned.map((option, index) => ({
    optionId: option.optionId,
    optionText: option.text,
    displayOrder: index,
    isCorrect: option.isCorrect
  }));
}

/**
 * Port of Angular's `pinAllOfTheAboveLast`. Moves EVERY matching option to the
 * end, preserving the relative order of the rest. Matching is by TEXT only —
 * never by correctness — so a wrong "All of the above" is pinned too.
 */
function pinAllOfTheAboveLast<T extends { text: string }>(items: T[]): T[] {
  if (items.length < 2) return items;
  if (!items.some((item) => isAllOfTheAbove(item.text))) return items;
  return [
    ...items.filter((item) => !isAllOfTheAbove(item.text)),
    ...items.filter((item) => isAllOfTheAbove(item.text))
  ];
}

// ── build ───────────────────────────────────────────────────────────

export function buildInterviewAssessment(
  config: InterviewBuildConfig,
  repository: QuizRepository,
  random: RandomSource
): GeneratedInterviewSnapshot {
  const { topicIds, questionCount } = config;

  // Pools are copies of the repository's frozen arrays. The master bank is
  // never shuffled, sliced or otherwise touched.
  const pools = new Map<string, PrivateQuestion[]>(
    topicIds.map((id) => [id, [...(repository.getQuizById(id)?.questions ?? [])]])
  );

  const capacity = new Map([...pools].map(([id, questions]) => [id, questions.length]));
  const allocation = allocate(topicIds, capacity, questionCount);

  const picked: PrivateQuestion[] = [];
  for (const topicId of topicIds) {
    const take = allocation.get(topicId) ?? 0;
    if (take <= 0) continue;
    // Shuffle the topic's pool, then take the first N — the Angular recipe,
    // which guarantees distinctness within a topic.
    const shuffled = shuffleArrayInPlace([...(pools.get(topicId) ?? [])], random);
    picked.push(...shuffled.slice(0, take));
  }

  const ordered = shuffleArrayInPlace(picked, random);

  const questions: GeneratedQuestionSnapshot[] = ordered.map((question, position) => ({
    position,
    questionId: question.questionId,
    sourceQuizId: question.sourceQuizId,
    questionText: question.questionText,
    questionType: question.type,
    explanation: question.explanation,
    options: orderOptions(question, random),
    ...(question.codeSnippet ? { codeSnippet: question.codeSnippet } : {})
  }));

  const snapshot: GeneratedInterviewSnapshot = {
    config,
    durationSeconds: config.durationSeconds,
    questions
  };

  assertSnapshotValid(snapshot);
  return snapshot;
}

/**
 * Last gate before persistence.
 *
 * The repository is already validated, but this is the boundary where a
 * generated assessment becomes durable and scoreable, so its invariants are
 * re-checked rather than assumed.
 */
export function assertSnapshotValid(
  snapshot: GeneratedInterviewSnapshot,
  options: { expectedCount?: number } = {}
): void {
  const { questions } = snapshot;

  // Presets use counts (15, 25) outside the Custom union, so the expected total
  // is passed explicitly rather than read from the narrowed config type.
  const expectedCount = options.expectedCount ?? snapshot.config.questionCount;
  if (questions.length !== expectedCount) {
    fail(
      'INVALID_GENERATED_SNAPSHOT',
      `generated ${questions.length} questions for a ${expectedCount}-question assessment`
    );
  }

  if (!Number.isFinite(snapshot.durationSeconds) || snapshot.durationSeconds <= 0) {
    // Regression guard for the latent Angular defect: a count with no entry in
    // the duration lookup yields `undefined`, which would ship a timer-less
    // interview. Never allowed to reach persistence.
    fail(
      'INVALID_GENERATED_SNAPSHOT',
      `assessment has an invalid duration (${String(snapshot.durationSeconds)})`
    );
  }

  const seenQuestionIds = new Set<string>();

  for (const [index, question] of questions.entries()) {
    const at = `question ${index}`;

    if (question.position !== index) {
      fail('INVALID_GENERATED_SNAPSHOT', `${at} has non-contiguous position ${question.position}`);
    }
    if (seenQuestionIds.has(question.questionId)) {
      fail('INVALID_GENERATED_SNAPSHOT', `${at} duplicates an earlier question`);
    }
    seenQuestionIds.add(question.questionId);

    if (question.questionId.trim().length === 0) fail('INVALID_GENERATED_SNAPSHOT', `${at} has no id`);
    if (question.sourceQuizId.trim().length === 0) fail('INVALID_GENERATED_SNAPSHOT', `${at} has no source quiz`);
    if (question.questionText.trim().length === 0) fail('INVALID_GENERATED_SNAPSHOT', `${at} has blank text`);
    if (question.explanation.trim().length === 0) fail('INVALID_GENERATED_SNAPSHOT', `${at} has a blank explanation`);

    const options = question.options;
    if (options.length < 2) fail('INVALID_GENERATED_SNAPSHOT', `${at} has fewer than two options`);

    const optionIds = new Set<number>();
    for (const [optionIndex, option] of options.entries()) {
      if (option.displayOrder !== optionIndex) {
        fail('INVALID_GENERATED_SNAPSHOT', `${at} has non-contiguous option display order`);
      }
      if (optionIds.has(option.optionId)) {
        fail('INVALID_GENERATED_SNAPSHOT', `${at} has a duplicate option id`);
      }
      optionIds.add(option.optionId);
      if (option.optionText.trim().length === 0) {
        fail('INVALID_GENERATED_SNAPSHOT', `${at} has a blank option`);
      }
    }

    const correctCount = options.filter((option) => option.isCorrect).length;
    if (question.questionType === 'multiple') {
      if (correctCount < 2) {
        fail('INVALID_GENERATED_SNAPSHOT', `${at} is multiple-answer with ${correctCount} correct options`);
      }
      if (correctCount === options.length) {
        fail('INVALID_GENERATED_SNAPSHOT', `${at} marks every option correct`);
      }
    } else if (correctCount !== 1) {
      // single and trueFalse are both single-selection.
      fail(
        'INVALID_GENERATED_SNAPSHOT',
        `${at} is single-selection with ${correctCount} correct options`
      );
    }
  }
}
