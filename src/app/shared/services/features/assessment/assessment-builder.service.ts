import { Service } from '@angular/core';

import {
  AssessmentConfig,
  AssessmentQuestionCount,
  DURATION_SECONDS_BY_COUNT
} from '../../../models/AssessmentConfig.model';
import { GeneratedAssessment } from '../../../models/GeneratedAssessment.model';
import { Option } from '../../../models/Option.model';
import { Quiz } from '../../../models/Quiz.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';

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
