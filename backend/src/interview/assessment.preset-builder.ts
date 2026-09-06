import type { PrivateQuestion } from '../quiz/quiz.types';
import type { QuizRepository } from '../quiz/quiz.repository';
import { orderOptions, assertSnapshotValid } from './assessment.builder';
import { shuffleArrayInPlace, type RandomSource } from './assessment.random';
import {
  AssessmentBuildError,
  type GeneratedInterviewSnapshot,
  type GeneratedQuestionSnapshot,
  type InterviewBuildConfig
} from './assessment.types';
import {
  calculateDifficultyQuota,
  DIFFICULTY_ORDER,
  resolvePreset,
  type DifficultyQuota,
  type InterviewPreset,
  type PresetCapacity,
  type QuizDifficulty
} from './interview-presets';

/**
 * Backend port of Angular's `AssessmentBuilderService.buildFromPreset()`.
 *
 * This is a genuinely DIFFERENT algorithm from the Custom `build()` path:
 * Custom balances across TOPICS with an even split; presets balance across
 * DIFFICULTY BANDS using quotas, then round-robin within each band.
 *
 * SHORTFALL STRATEGY (ported exactly, per the Angular doc comment):
 *   1. fill each difficulty from its own topics, round-robin across them
 *   2. carry any shortfall to the CLOSEST difficulty the preset ALLOWS
 *      (nonzero weight), nearest-first by DIFFICULTY_ORDER distance, ties
 *      resolved toward the LOWER difficulty
 *   3. a zero-weighted difficulty is never used — Junior can never receive an
 *      advanced question
 *   4. topics outside the preset are never used
 */

/** Port of `presetCapacity`. Only the preset's own topics are counted. */
export function presetCapacity(
  preset: InterviewPreset,
  repository: QuizRepository
): PresetCapacity {
  const byDifficulty: DifficultyQuota = { beginner: 0, intermediate: 0, advanced: 0 };

  for (const topicId of dedupe(preset.topicIds)) {
    const quiz = repository.getQuizById(topicId);
    const difficulty = quiz?.difficulty as QuizDifficulty | undefined;
    if (!difficulty || !(difficulty in byDifficulty)) continue;
    byDifficulty[difficulty] += quiz?.questions.length ?? 0;
  }

  const usable = DIFFICULTY_ORDER.reduce(
    (sum, difficulty) =>
      sum + (preset.difficultyDistribution[difficulty] > 0 ? byDifficulty[difficulty] : 0),
    0
  );

  return { byDifficulty, usable, required: preset.questionCount };
}

function dedupe(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Port of `redistributionOrder`.
 *
 * The anchor is the difficulty that carried the LARGEST original quota — the
 * preset's centre of gravity. `sort` is stable, so an exact tie on quota keeps
 * DIFFICULTY_ORDER order and the LOWER difficulty anchors. Candidates are then
 * ordered by distance from the anchor, ties resolved toward the lower
 * difficulty, so a shortfall never silently makes an interview harder than the
 * preset advertises.
 *
 * Concretely:
 *   junior     quota 9/6/0,  allowed b,i     → beginner, intermediate
 *   mid-level  quota 4/12/4, allowed b,i,a   → intermediate, beginner, advanced
 *   senior     quota 2/10/13, allowed b,i,a  → advanced, intermediate, beginner
 */
export function redistributionOrder(
  quota: DifficultyQuota,
  allowed: readonly QuizDifficulty[]
): QuizDifficulty[] {
  const anchorIndex = DIFFICULTY_ORDER.indexOf(
    [...DIFFICULTY_ORDER].sort((a, b) => quota[b] - quota[a])[0] as QuizDifficulty
  );

  return [...allowed].sort((a, b) => {
    const da = Math.abs(DIFFICULTY_ORDER.indexOf(a) - anchorIndex);
    const db = Math.abs(DIFFICULTY_ORDER.indexOf(b) - anchorIndex);
    return da - db || DIFFICULTY_ORDER.indexOf(a) - DIFFICULTY_ORDER.indexOf(b);
  });
}

/**
 * Port of `takeBalanced`. Consumes from the front of each topic's already
 * shuffled pool, round-robin, so one large topic cannot dominate and a question
 * can never be taken twice.
 */
function takeBalanced(
  topicIds: readonly string[],
  remaining: Map<string, PrivateQuestion[]>,
  want: number
): PrivateQuestion[] {
  const out: PrivateQuestion[] = [];
  if (want <= 0 || topicIds.length === 0) return out;

  let progressed = true;
  while (out.length < want && progressed) {
    progressed = false;
    for (const topicId of topicIds) {
      if (out.length >= want) break;
      const pool = remaining.get(topicId);
      if (pool && pool.length > 0) {
        out.push(pool.shift() as PrivateQuestion);
        progressed = true;
      }
    }
  }
  return out;
}

export function buildPresetAssessment(
  preset: InterviewPreset,
  repository: QuizRepository,
  random: RandomSource
): GeneratedInterviewSnapshot {
  const capacity = presetCapacity(preset, repository);
  if (capacity.usable < preset.questionCount) {
    throw new AssessmentBuildError(
      'INSUFFICIENT_QUESTIONS',
      `preset "${preset.id}" needs ${preset.questionCount} questions but only ${capacity.usable} are available`
    );
  }

  const topicIds = dedupe(preset.topicIds);
  const topicsByDifficulty = new Map<QuizDifficulty, string[]>();
  const pools = new Map<string, PrivateQuestion[]>();

  for (const topicId of topicIds) {
    const quiz = repository.getQuizById(topicId);
    const difficulty = quiz?.difficulty as QuizDifficulty | undefined;
    // A topic with no difficulty is skipped, exactly as Angular does.
    if (!difficulty) continue;
    pools.set(topicId, [...(quiz?.questions ?? [])]);
    topicsByDifficulty.set(difficulty, [...(topicsByDifficulty.get(difficulty) ?? []), topicId]);
  }

  const quota = calculateDifficultyQuota(preset.questionCount, preset.difficultyDistribution);
  const allowed = DIFFICULTY_ORDER.filter((d) => preset.difficultyDistribution[d] > 0);

  // One shuffle per topic pool, in topicIds order — the draw sequence matters
  // for parity under a seeded source.
  const remaining = new Map<string, PrivateQuestion[]>(
    [...pools.entries()].map(([id, questions]) => [id, shuffleArrayInPlace([...questions], random)])
  );

  const picked: PrivateQuestion[] = [];
  let shortfall = 0;

  for (const difficulty of DIFFICULTY_ORDER) {
    const want = quota[difficulty];
    if (want <= 0) continue;
    const taken = takeBalanced(topicsByDifficulty.get(difficulty) ?? [], remaining, want);
    picked.push(...taken);
    shortfall += want - taken.length;
  }

  if (shortfall > 0) {
    for (const difficulty of redistributionOrder(quota, allowed)) {
      if (shortfall === 0) break;
      const taken = takeBalanced(topicsByDifficulty.get(difficulty) ?? [], remaining, shortfall);
      picked.push(...taken);
      shortfall -= taken.length;
    }
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

  const resolved = resolvePreset(preset);
  const config: InterviewBuildConfig = {
    // Angular stores 'mixed' for a preset assessment; the real band mix lives in
    // the preset definition, not in this field.
    difficulty: 'mixed',
    topicIds,
    questionCount: resolved.questionCount,
    durationSeconds: resolved.durationSeconds,
    presetId: resolved.presetId,
    presetName: resolved.presetName
  };

  const snapshot: GeneratedInterviewSnapshot = {
    config,
    durationSeconds: resolved.durationSeconds,
    questions
  };

  assertSnapshotValid(snapshot, { expectedCount: preset.questionCount });
  return snapshot;
}
