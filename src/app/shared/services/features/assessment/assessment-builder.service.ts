import { Service } from '@angular/core';

import {
  AssessmentConfig,
  AssessmentQuestionCount,
  DURATION_SECONDS_BY_COUNT,
  InterviewDifficulty
} from '../../../models/AssessmentConfig.model';
import { GeneratedAssessment } from '../../../models/GeneratedAssessment.model';
import { Option } from '../../../models/Option.model';
import { Quiz, QuizDifficulty } from '../../../models/Quiz.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';
import { InterviewPreset } from '../../../models/interview-preset.model';
import {
  calculateDifficultyQuota,
  DifficultyQuota,
  DIFFICULTY_ORDER
} from '../../../utils/difficulty-quota';

import { getQuizData } from '../../../quiz-data-cache';
import { ArrayUtils } from '../../../utils/array-utils';
import { pinAllOfTheAboveLast } from '../../../utils/all-of-the-above';
import { isOptionCorrect } from '../../../utils/is-option-correct';

// Deep clone helper. Prefers structuredClone (used across the app, e.g.
// QuizService.quizInitialState) but falls back to JSON so unit tests running
// under jsdom — which may lack structuredClone — don't need a global polyfill.
function deepClone<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

// Result of counting the eligible pool for a difficulty + topic selection.
// Used by the Build Your Interview page to derive validity and the preview
// (and to explain why a configuration is invalid) without persisting anything.
export interface EligiblePool {
  total: number;
  perTopic: Map<string, number>;
}

/**
 * What a role preset can actually supply. `usable` counts only difficulties the
 * preset allows (nonzero weight), so a zero-weighted band's questions are never
 * treated as available — that is what keeps Advanced out of the Junior preset.
 */
export interface PresetCapacity {
  byDifficulty: DifficultyQuota;
  usable: number;
  required: number;
}

/**
 * Reusable, UI-agnostic engine that answers a single question:
 * "Given this configuration, which questions should the assessment include?"
 *
 * It reads the existing quiz catalog, filters by difficulty + topics, balances
 * questions across the selected topics, clones + resets mutable answer state so
 * the source catalog is never mutated, then shuffles question and option order.
 * It has NO Interview-specific UI behavior and leaves quiz.json untouched.
 */
@Service()
export class AssessmentBuilderService {
  private sequence = 0;

  // The topics (source quizzes) eligible for a difficulty. 'mixed' = all
  // topics; otherwise only quizzes whose per-quiz difficulty matches.
  eligibleTopicIds(difficulty: InterviewDifficulty): string[] {
    return this.catalog()
      .filter((quiz) => difficulty === 'mixed' || quiz.difficulty === difficulty)
      .map((quiz) => quiz.quizId);
  }

  // Size of the question pool for the selected topics (difficulty is already
  // encoded in which topics the caller passes). perTopic drives the preview and
  // the "Only N questions available…" invalid-reason message.
  countEligible(topicIds: string[]): EligiblePool {
    const perTopic = new Map<string, number>();
    let total = 0;
    for (const id of this.dedupe(topicIds)) {
      const count = this.findQuiz(id)?.questions?.length ?? 0;
      perTopic.set(id, count);
      total += count;
    }
    return { total, perTopic };
  }

  // True when a valid, duplicate-free assessment of `questionCount` can be built
  // from the selected topics. The Build page derives Start-button validity from
  // this rather than persisting a boolean flag.
  canBuild(config: AssessmentConfig): boolean {
    const topicIds = this.dedupe(config.topicIds);
    return topicIds.length > 0 && this.countEligible(topicIds).total >= config.questionCount;
  }

  /**
   * Build a temporary assessment. Throws if the selected topics can't supply
   * `questionCount` distinct questions (the page prevents this; the engine is
   * defensive). Randomness is confined to ArrayUtils.shuffleArray, so mocking it
   * makes the whole build deterministic for tests.
   */
  build(
    config: AssessmentConfig,
    sourceByTopic?: ReadonlyMap<string, readonly QuizQuestion[]>
  ): GeneratedAssessment {
    const topicIds = this.dedupe(config.topicIds);
    if (topicIds.length === 0) {
      throw new Error('AssessmentBuilder: at least one topic must be selected');
    }

    // 1. Gather each topic's pool as deep clones with answer state reset. The
    //    clone means answer selection can never mutate the source.
    //
    //    `sourceByTopic` lets a caller supply the questions instead of reading
    //    the local catalog — Weak Areas Practice passes API-sourced questions,
    //    which carry a declared type and NO answer key. Balancing, cloning,
    //    shuffling and the AOTA pin stay right here, so there is still exactly
    //    one generator rather than a second, divergent one.
    const pools = new Map<string, QuizQuestion[]>();
    for (const id of topicIds) {
      const source = sourceByTopic
        ? [...(sourceByTopic.get(id) ?? [])]
        : (this.findQuiz(id)?.questions ?? []);
      pools.set(id, source.map((q, i) => this.cloneQuestion(q, id, i)));
    }

    const available = [...pools.values()].reduce((sum, qs) => sum + qs.length, 0);
    if (available < config.questionCount) {
      throw new Error(
        `AssessmentBuilder: only ${available} questions available for ${config.questionCount} requested`
      );
    }

    // 2. Balance the count across topics, respecting each topic's capacity.
    const allocation = this.allocate(topicIds, pools, config.questionCount);

    // 3. Pick N distinct questions per topic (shuffle then take N → no dupes).
    const picked: QuizQuestion[] = [];
    for (const id of topicIds) {
      const take = allocation.get(id) ?? 0;
      if (take <= 0) continue;
      const shuffled = ArrayUtils.shuffleArray([...(pools.get(id) ?? [])]);
      picked.push(...shuffled.slice(0, take));
    }

    // 4. Shuffle final question order, then shuffle each question's options
    //    (AOTA pinned last).
    const ordered = ArrayUtils.shuffleArray(picked);
    const questions = ordered.map((q) => this.shuffleOptions(q));

    return {
      id: `interview-${++this.sequence}`,
      title: 'Angular Interview',
      questions,
      config: { ...config, topicIds },
      durationSeconds: DURATION_SECONDS_BY_COUNT[config.questionCount as AssessmentQuestionCount]
    };
  }

  // ── weak areas practice ─────────────────────────────────────────

  /**
   * Questions available across the given weak topics.
   *
   * With `sourceByTopic` the count comes from the supplied questions, so the
   * API-sourced practice path never consults the local catalog — not even to
   * size itself.
   */
  practiceCapacity(
    topicIds: readonly string[],
    sourceByTopic?: ReadonlyMap<string, readonly QuizQuestion[]>
  ): number {
    if (sourceByTopic) {
      return this.dedupe([...topicIds]).reduce(
        (sum, id) => sum + (sourceByTopic.get(id)?.length ?? 0),
        0
      );
    }
    return this.countEligible([...topicIds]).total;
  }

  /**
   * Build an untimed Weak Areas Practice session from the calculated weak
   * topics.
   *
   * Deliberately a thin wrapper over build(): that path already balances across
   * topics, deep-clones + resets answer state, shuffles with
   * ArrayUtils.shuffleArray, shuffles options with "All of the above" pinned
   * last, and stamps sourceQuizId on every question. Re-implementing any of that
   * here would create a second, divergent generator.
   *
   * The only practice-specific rules are the cap and the shortfall behaviour:
   * take at most `max` questions, or everything available when the weak topics
   * hold fewer. Returns null when there is nothing to practise, so callers never
   * start an empty session.
   */
  buildPractice(
    topicIds: readonly string[],
    max = 10,
    sourceByTopic?: ReadonlyMap<string, readonly QuizQuestion[]>
  ): GeneratedAssessment | null {
    const ids = this.dedupe([...topicIds]);
    if (ids.length === 0) return null;

    const available = this.practiceCapacity(ids, sourceByTopic);
    if (available <= 0) return null;

    const questionCount = Math.min(max, available);
    const built = this.build(
      {
        difficulty: 'mixed',
        topicIds: ids,
        questionCount: questionCount as AssessmentConfig['questionCount']
      },
      sourceByTopic
    );

    // Practice is UNTIMED: no countdown is derived or displayed.
    return { ...built, id: `practice-${built.id}`, title: 'Weak Areas Practice', durationSeconds: 0 };
  }

  // ── role presets ────────────────────────────────────────────────

  /**
   * How many questions a preset can actually supply, per difficulty. Drives the
   * Start-button state and the shortfall message WITHOUT building anything.
   * Only the preset's own topics are ever counted.
   */
  presetCapacity(preset: InterviewPreset): PresetCapacity {
    const byDifficulty = { beginner: 0, intermediate: 0, advanced: 0 } as DifficultyQuota;
    for (const topicId of this.dedupe([...preset.topicIds])) {
      const quiz = this.findQuiz(topicId);
      const difficulty = quiz?.difficulty as QuizDifficulty | undefined;
      if (!difficulty || !(difficulty in byDifficulty)) continue;
      byDifficulty[difficulty] += quiz?.questions?.length ?? 0;
    }
    // Only difficulties the preset actually allows (nonzero weight) can be used,
    // so a zero-weighted difficulty contributes nothing to usable capacity.
    const usable = DIFFICULTY_ORDER.reduce(
      (sum, d) => sum + (preset.difficultyDistribution[d] > 0 ? byDifficulty[d] : 0),
      0
    );
    return { byDifficulty, usable, required: preset.questionCount };
  }

  /** True when the preset can supply its full requested count. */
  canBuildPreset(preset: InterviewPreset): boolean {
    return this.presetCapacity(preset).usable >= preset.questionCount;
  }

  /**
   * Build a role-preset assessment. Reuses the SAME cloning, reset, balancing
   * and shuffling as build() — this is an extension of the existing engine, not
   * a competing generator.
   *
   * Difficulty here is a property of the TOPIC (quiz), not of an individual
   * question, so a quota of "9 beginner" means nine questions drawn from the
   * preset's beginner-difficulty topics.
   *
   * SHORTFALL STRATEGY, applied per difficulty in order:
   *   1. fill from that difficulty's topics, balanced round-robin across them;
   *   2. any shortfall is carried to the CLOSEST other difficulty that the
   *      preset allows (nonzero weight), nearest-first by DIFFICULTY_ORDER
   *      distance, ties resolved toward the LOWER difficulty so a shortfall
   *      never inflates the hardest band unexpectedly;
   *   3. a zero-weighted difficulty is never used — Junior can therefore never
   *      receive an advanced question;
   *   4. topics outside the preset are never used.
   */
  buildFromPreset(preset: InterviewPreset): GeneratedAssessment {
    const capacity = this.presetCapacity(preset);
    if (capacity.usable < preset.questionCount) {
      throw new Error(
        `AssessmentBuilder: preset "${preset.id}" needs ${preset.questionCount} questions but only ${capacity.usable} are available`
      );
    }

    // Pools per difficulty, restricted to the preset's own topics.
    const topicIds = this.dedupe([...preset.topicIds]);
    const topicsByDifficulty = new Map<QuizDifficulty, string[]>();
    const pools = new Map<string, QuizQuestion[]>();
    for (const topicId of topicIds) {
      const quiz = this.findQuiz(topicId);
      const difficulty = quiz?.difficulty as QuizDifficulty | undefined;
      if (!difficulty) continue;
      pools.set(topicId, (quiz?.questions ?? []).map((q, i) => this.cloneQuestion(q, topicId, i)));
      topicsByDifficulty.set(difficulty, [...(topicsByDifficulty.get(difficulty) ?? []), topicId]);
    }

    const quota = calculateDifficultyQuota(preset.questionCount, preset.difficultyDistribution);
    const allowed = DIFFICULTY_ORDER.filter((d) => preset.difficultyDistribution[d] > 0);

    // Remaining capacity per topic, decremented as we take questions so the same
    // question can never be selected twice.
    const remaining = new Map<string, QuizQuestion[]>(
      [...pools.entries()].map(([id, qs]) => [id, ArrayUtils.shuffleArray([...qs])])
    );

    const picked: QuizQuestion[] = [];
    let shortfall = 0;

    for (const difficulty of DIFFICULTY_ORDER) {
      const want = quota[difficulty];
      if (want <= 0) continue;
      const taken = this.takeBalanced(topicsByDifficulty.get(difficulty) ?? [], remaining, want);
      picked.push(...taken);
      shortfall += want - taken.length;
    }

    // Redistribute any shortfall to the closest ALLOWED difficulty with capacity.
    if (shortfall > 0) {
      for (const difficulty of this.redistributionOrder(quota, allowed)) {
        if (shortfall === 0) break;
        const taken = this.takeBalanced(topicsByDifficulty.get(difficulty) ?? [], remaining, shortfall);
        picked.push(...taken);
        shortfall -= taken.length;
      }
    }

    const ordered = ArrayUtils.shuffleArray(picked);
    const questions = ordered.map((q) => this.shuffleOptions(q));

    const config: AssessmentConfig = {
      difficulty: 'mixed',
      topicIds,
      questionCount: preset.questionCount as AssessmentConfig['questionCount'],
      presetId: preset.id,
      presetName: preset.name,
      durationSecondsOverride: preset.durationMinutes * 60
    };

    return {
      id: `interview-${++this.sequence}`,
      title: preset.name,
      questions,
      config,
      durationSeconds: preset.durationMinutes * 60
    };
  }

  /**
   * Difficulties to raid when a quota can't be met, nearest-first. Distance is
   * measured on DIFFICULTY_ORDER; equal distances resolve toward the LOWER
   * difficulty (documented, deterministic) so a shortfall never silently makes
   * an interview harder than its preset advertises.
   */
  private redistributionOrder(
    quota: DifficultyQuota,
    allowed: readonly QuizDifficulty[]
  ): QuizDifficulty[] {
    // Anchor on the difficulty that carried the largest original quota — the
    // preset's centre of gravity — so redistribution stays close to its intent.
    const anchorIndex = DIFFICULTY_ORDER.indexOf(
      [...DIFFICULTY_ORDER].sort((a, b) => quota[b] - quota[a])[0]
    );
    return [...allowed].sort((a, b) => {
      const da = Math.abs(DIFFICULTY_ORDER.indexOf(a) - anchorIndex);
      const db = Math.abs(DIFFICULTY_ORDER.indexOf(b) - anchorIndex);
      return da - db || DIFFICULTY_ORDER.indexOf(a) - DIFFICULTY_ORDER.indexOf(b);
    });
  }

  /**
   * Take up to `want` questions from `topicIds`, round-robin, so one large topic
   * cannot dominate. Consumes from `remaining` (already shuffled per topic), so
   * a question is never selected twice.
   */
  private takeBalanced(
    topicIds: readonly string[],
    remaining: Map<string, QuizQuestion[]>,
    want: number
  ): QuizQuestion[] {
    const out: QuizQuestion[] = [];
    if (want <= 0 || topicIds.length === 0) return out;
    let progressed = true;
    while (out.length < want && progressed) {
      progressed = false;
      for (const topicId of topicIds) {
        if (out.length >= want) break;
        const pool = remaining.get(topicId);
        if (pool && pool.length > 0) {
          out.push(pool.shift() as QuizQuestion);
          progressed = true;
        }
      }
    }
    return out;
  }

  // ── balancing ───────────────────────────────────────────────────

  // Even split with remainder to the first topics, each capped by that topic's
  // capacity; leftover from capped topics is redistributed round-robin to
  // topics that still have spare questions. Example: 3 topics / 20 → 7,7,6.
  private allocate(
    topicIds: string[],
    pools: Map<string, QuizQuestion[]>,
    count: number
  ): Map<string, number> {
    const capacity = new Map(topicIds.map((id) => [id, pools.get(id)?.length ?? 0]));
    const alloc = new Map(topicIds.map((id) => [id, 0]));

    const base = Math.floor(count / topicIds.length);
    const remainder = count % topicIds.length;
    for (const [i, id] of topicIds.entries()) {
      const target = base + (i < remainder ? 1 : 0);
      alloc.set(id, Math.min(target, capacity.get(id) ?? 0));
    }

    let assigned = [...alloc.values()].reduce((a, b) => a + b, 0);
    while (assigned < count) {
      const spare = topicIds.filter((id) => (capacity.get(id) ?? 0) - (alloc.get(id) ?? 0) > 0);
      if (spare.length === 0) break;   // unreachable when available >= count
      for (const id of spare) {
        if (assigned >= count) break;
        alloc.set(id, (alloc.get(id) ?? 0) + 1);
        assigned++;
      }
    }
    return alloc;
  }

  // ── cloning / normalization ─────────────────────────────────────

  // Deep clone a source question, reset all mutable answer/selection state, and
  // stamp its source topic. Mirrors QuizShuffleService.cloneAndNormalizeOptions'
  // reset recipe so behavior matches the normal quiz pipeline.
  private cloneQuestion(source: QuizQuestion, sourceQuizId: string, index: number): QuizQuestion {
    const cloned = deepClone(source);
    return {
      ...cloned,
      sourceQuizId,
      options: this.resetOptions(cloned.options ?? [], index),
      selectedOptions: [],
      selectedOptionIds: []
    };
  }

  private resetOptions(options: Option[], questionIndex: number): Option[] {
    return options.map((option, i) => {
      const existingId = typeof option.optionId === 'number' && option.optionId > 0
        ? option.optionId
        : (questionIndex + 1) * 100 + (i + 1);
      return {
        ...option,
        optionId: existingId,
        displayOrder: i,
        // PRESERVE ABSENCE. `option.correct === true` is FALSE for an option
        // that carries no `correct` at all, so an API-sourced practice option
        // came out of here asserting it is WRONG. Weak Areas questions now come
        // from `GET /questions`, which ships no answer key, and correctness is
        // the /check verdict's to give. Bank-sourced options (the Interview
        // generator's other callers) keep whatever flag they genuinely have.
        ...(option.correct === undefined ? {} : { correct: isOptionCorrect(option) }),
        value: typeof option.value === 'number' ? option.value : existingId,
        selected: false,
        highlight: false,
        showIcon: false,
        showFeedback: false,
        _autoRevealedCorrect: false
      };
    });
  }

  // Shuffle options and pin any "All of the above" option last (idempotent with
  // the SharedOptionComponent display-layer pin), then renumber displayOrder.
  private shuffleOptions(question: QuizQuestion): QuizQuestion {
    const shuffled = ArrayUtils.shuffleArray([...(question.options ?? [])]);
    const pinned = pinAllOfTheAboveLast(shuffled, (o) => o.text);
    const options = pinned.map((option, i) => ({ ...option, displayOrder: i }));
    return { ...question, options };
  }

  // ── catalog access ──────────────────────────────────────────────

  private catalog(): Quiz[] {
    return getQuizData() ?? [];
  }

  private findQuiz(quizId: string): Quiz | undefined {
    return this.catalog().find((quiz) => quiz.quizId === quizId);
  }

  private dedupe(ids: string[]): string[] {
    return [...new Set(ids ?? [])];
  }
}
