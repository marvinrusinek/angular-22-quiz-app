import {
  buildPresetAssessment,
  presetCapacity,
  redistributionOrder
} from '../src/interview/assessment.preset-builder';
import {
  calculateDifficultyQuota,
  findInterviewPreset,
  INTERVIEW_PRESETS,
  isValidDistribution,
  resolvePreset,
  type InterviewPreset
} from '../src/interview/interview-presets';
import { seededRandomSource } from '../src/interview/assessment.random';
import { isAllOfTheAbove } from '../src/interview/all-of-the-above';
import { AssessmentBuildError } from '../src/interview/assessment.types';
import { createQuizRepository } from '../src/quiz/quiz.repository';
import { presetTopicsRepository } from './helpers/fixtures';

/**
 * PARITY REFERENCE
 *   src/app/shared/models/interview-preset.model.ts
 *   src/app/shared/utils/difficulty-quota.ts
 *   AssessmentBuilderService.buildFromPreset / presetCapacity / redistributionOrder
 */

const repo = () => presetTopicsRepository();
const seeded = () => seededRandomSource(6060);
const preset = (id: string): InterviewPreset => findInterviewPreset(id)!;

describe('preset definitions', () => {
  it('ships exactly the three role presets', () => {
    expect(INTERVIEW_PRESETS.map((p) => p.id)).toEqual(['junior', 'mid-level', 'senior']);
  });

  it.each([
    ['junior', 15, 20, { beginner: 60, intermediate: 40, advanced: 0 }],
    ['mid-level', 20, 30, { beginner: 20, intermediate: 60, advanced: 20 }],
    ['senior', 25, 40, { beginner: 10, intermediate: 40, advanced: 50 }]
  ])('%s: %i questions, %i minutes', (id, count, minutes, distribution) => {
    const found = preset(id);
    expect(found.questionCount).toBe(count);
    expect(found.durationMinutes).toBe(minutes);
    expect(found.difficultyDistribution).toEqual(distribution);
    expect(isValidDistribution(found.difficultyDistribution)).toBe(true);
  });

  it('every preset topic exists in the real bank', () => {
    const repository = repo();
    for (const p of INTERVIEW_PRESETS) {
      for (const topicId of p.topicIds) {
        expect(repository.getQuizById(topicId)).toBeDefined();
      }
    }
  });

  it('returns undefined for an unknown preset id', () => {
    expect(findInterviewPreset('architect')).toBeUndefined();
    expect(findInterviewPreset(null)).toBeUndefined();
  });
});

describe('difficulty quota parity', () => {
  it.each([
    ['junior', { beginner: 9, intermediate: 6, advanced: 0 }],
    ['mid-level', { beginner: 4, intermediate: 12, advanced: 4 }],
    ['senior', { beginner: 2, intermediate: 10, advanced: 13 }]
  ])('%s quota matches the documented split', (id, expected) => {
    const found = preset(id);
    expect(calculateDifficultyQuota(found.questionCount, found.difficultyDistribution))
      .toEqual(expected);
  });

  it('SENIOR proves the tie rule — the .5 leftover goes to the HIGHER difficulty', () => {
    // floors are 2 / 10 / 12 = 24; one leftover, remainders .5 (beginner) and
    // .5 (advanced) → advanced wins.
    const quota = calculateDifficultyQuota(25, { beginner: 10, intermediate: 40, advanced: 50 });
    expect(quota.advanced).toBe(13);
    expect(quota.beginner).toBe(2);
  });

  it('a 0%-weighted difficulty never receives a question', () => {
    expect(calculateDifficultyQuota(15, { beginner: 60, intermediate: 40, advanced: 0 }).advanced)
      .toBe(0);
  });

  it('always sums to the requested total', () => {
    for (const total of [1, 7, 13, 15, 20, 25, 30, 99]) {
      const quota = calculateDifficultyQuota(total, { beginner: 33, intermediate: 33, advanced: 34 });
      expect(quota.beginner + quota.intermediate + quota.advanced).toBe(total);
    }
  });

  it('rejects a malformed distribution or count', () => {
    expect(() => calculateDifficultyQuota(10, { beginner: 50, intermediate: 40, advanced: 0 }))
      .toThrow(/total 100/);
    expect(() => calculateDifficultyQuota(-1, { beginner: 100, intermediate: 0, advanced: 0 }))
      .toThrow(/non-negative/);
  });
});

describe('redistribution order', () => {
  it.each([
    ['junior', ['beginner', 'intermediate']],
    ['mid-level', ['intermediate', 'beginner', 'advanced']],
    ['senior', ['advanced', 'intermediate', 'beginner']]
  ])('%s redistributes nearest-first from its quota anchor', (id, expected) => {
    const found = preset(id);
    const quota = calculateDifficultyQuota(found.questionCount, found.difficultyDistribution);
    const allowed = (['beginner', 'intermediate', 'advanced'] as const)
      .filter((d) => found.difficultyDistribution[d] > 0);
    expect(redistributionOrder(quota, allowed)).toEqual(expected);
  });

  it('ties resolve toward the LOWER difficulty', () => {
    // anchor = intermediate; beginner and advanced are both distance 1.
    const order = redistributionOrder(
      { beginner: 1, intermediate: 5, advanced: 1 },
      ['beginner', 'intermediate', 'advanced']
    );
    expect(order).toEqual(['intermediate', 'beginner', 'advanced']);
  });

  it('never includes a difficulty the preset disallows', () => {
    const order = redistributionOrder({ beginner: 9, intermediate: 6, advanced: 0 }, ['beginner', 'intermediate']);
    expect(order).not.toContain('advanced');
  });
});

describe('preset capacity', () => {
  it.each(['junior', 'mid-level', 'senior'])('%s can supply its full count', (id) => {
    const capacity = presetCapacity(preset(id), repo());
    expect(capacity.usable).toBeGreaterThanOrEqual(capacity.required);
  });

  it('EXCLUDES zero-weighted difficulties from usable capacity', () => {
    const junior = preset('junior');
    const capacity = presetCapacity(junior, repo());
    // Junior weights advanced at 0%, so advanced topics contribute nothing —
    // and junior configures none anyway.
    expect(capacity.byDifficulty.advanced).toBe(0);
    expect(capacity.usable).toBe(capacity.byDifficulty.beginner + capacity.byDifficulty.intermediate);
  });
});

describe('building each preset', () => {
  it.each(['junior', 'mid-level', 'senior'])('%s builds the exact count and duration', (id) => {
    const found = preset(id);
    const snapshot = buildPresetAssessment(found, repo(), seeded());

    expect(snapshot.questions).toHaveLength(found.questionCount);
    expect(snapshot.durationSeconds).toBe(found.durationMinutes * 60);
    expect(snapshot.config.presetId).toBe(found.id);
    expect(snapshot.config.presetName).toBe(found.name);
    expect(snapshot.config.difficulty).toBe('mixed');
  });

  it('NEVER produces an invalid duration', () => {
    for (const p of INTERVIEW_PRESETS) {
      const snapshot = buildPresetAssessment(p, repo(), seeded());
      expect(Number.isFinite(snapshot.durationSeconds)).toBe(true);
      expect(snapshot.durationSeconds).toBeGreaterThan(0);
      expect(Number.isNaN(snapshot.durationSeconds)).toBe(false);
    }
  });

  it.each(['junior', 'mid-level', 'senior'])('%s contains no duplicate questions', (id) => {
    const snapshot = buildPresetAssessment(preset(id), repo(), seeded());
    const ids = snapshot.questions.map((q) => q.questionId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(['junior', 'mid-level', 'senior'])('%s draws only from its own topics', (id) => {
    const found = preset(id);
    const allowedTopics = new Set(found.topicIds);
    const snapshot = buildPresetAssessment(found, repo(), seeded());
    for (const question of snapshot.questions) {
      expect(allowedTopics.has(question.sourceQuizId)).toBe(true);
    }
  });

  it('JUNIOR never receives an advanced question — 0%% weight is absolute', () => {
    const repository = repo();
    const snapshot = buildPresetAssessment(preset('junior'), repository, seeded());
    for (const question of snapshot.questions) {
      expect(repository.getQuizById(question.sourceQuizId)!.difficulty).not.toBe('advanced');
    }
  });

  function bandCounts(id: string) {
    const repository = repo();
    const snapshot = buildPresetAssessment(preset(id), repository, seeded());
    const actual = { beginner: 0, intermediate: 0, advanced: 0 };
    for (const question of snapshot.questions) {
      const difficulty = repository.getQuizById(question.sourceQuizId)!.difficulty as keyof typeof actual;
      actual[difficulty]++;
    }
    return actual;
  }

  it.each(['junior', 'mid-level'])('%s meets its per-difficulty quota exactly', (id) => {
    const found = preset(id);
    // Both configure a topic for every nonzero-weighted band, so there is
    // nothing to redistribute and the bands match the quota exactly.
    expect(bandCounts(id))
      .toEqual(calculateDifficultyQuota(found.questionCount, found.difficultyDistribution));
  });

  it('SENIOR redistributes its unfillable beginner quota — a real preset defect', () => {
    // The shipped senior preset weights beginner at 10% (quota 2) but configures
    // NO beginner topic. The builder cannot fill that band, so the shortfall is
    // carried to the nearest allowed difficulty (advanced, per the senior
    // redistribution order) and the interview ends up 0/10/15 rather than
    // 2/10/13.
    //
    // This is EXISTING Angular behaviour, faithfully reproduced. Angular's own
    // `validateInterviewPresets()` reports it as
    //   '10% weighted to "beginner" but no beginner topic is configured'.
    // Fixing the preset data is a product decision, not part of this migration.
    const quota = calculateDifficultyQuota(25, preset('senior').difficultyDistribution);
    expect(quota).toEqual({ beginner: 2, intermediate: 10, advanced: 13 });

    expect(bandCounts('senior')).toEqual({ beginner: 0, intermediate: 10, advanced: 15 });
  });

  it('confirms the senior preset genuinely has no beginner topic', () => {
    const repository = repo();
    const difficulties = preset('senior').topicIds.map(
      (topicId) => repository.getQuizById(topicId)!.difficulty
    );
    expect(difficulties).not.toContain('beginner');
  });

  it('is deterministic under a seed and varies across seeds', () => {
    const a = buildPresetAssessment(preset('senior'), repo(), seededRandomSource(11));
    const b = buildPresetAssessment(preset('senior'), repo(), seededRandomSource(11));
    const c = buildPresetAssessment(preset('senior'), repo(), seededRandomSource(12));

    expect(a.questions.map((q) => q.questionId)).toEqual(b.questions.map((q) => q.questionId));
    expect(a.questions.map((q) => q.questionId)).not.toEqual(c.questions.map((q) => q.questionId));
  });

  it('gives contiguous positions and display orders, with stable option ids', () => {
    const repository = repo();
    const snapshot = buildPresetAssessment(preset('mid-level'), repository, seeded());

    expect(snapshot.questions.map((q) => q.position)).toEqual([...Array(20).keys()]);
    for (const question of snapshot.questions) {
      expect(question.options.map((o) => o.displayOrder))
        .toEqual([...Array(question.options.length).keys()]);
      const source = repository.getQuestionById(question.questionId)!;
      expect([...question.options.map((o) => o.optionId)].sort((a, b) => a - b))
        .toEqual([...source.options.map((o) => o.optionId)].sort((a, b) => a - b));
    }
  });

  it('carries explicit question types', () => {
    const repository = repo();
    const snapshot = buildPresetAssessment(preset('senior'), repository, seeded());
    for (const question of snapshot.questions) {
      expect(['single', 'multiple', 'trueFalse']).toContain(question.questionType);
      expect(question.questionType).toBe(repository.getQuestionById(question.questionId)!.type);
    }
  });

  it('keeps "All of the above" last wherever it occurs', () => {
    const snapshot = buildPresetAssessment(preset('senior'), repo(), seeded());
    for (const question of snapshot.questions) {
      const index = question.options.findIndex((o) => isAllOfTheAbove(o.optionText));
      if (index === -1) continue;
      expect(index).toBe(question.options.length - 1);
    }
  });
});

describe('shortfall redistribution', () => {
  /** A bank where one band is deliberately too small for its quota. */
  function shortBank(counts: { beginner: number; intermediate: number; advanced: number }) {
    const make = (quizId: string, difficulty: string, n: number) => ({
      quizId, milestone: quizId, summary: '', image: '', difficulty,
      questions: Array.from({ length: n }, (_unused, i) => ({
        questionText: `${quizId} question ${i}?`,
        explanation: 'Because.',
        options: [{ text: 'A', correct: true }, { text: 'B' }]
      }))
    });
    return createQuizRepository({
      source: {
        quizzes: [
          make('b1', 'beginner', counts.beginner),
          make('i1', 'intermediate', counts.intermediate),
          make('a1', 'advanced', counts.advanced)
        ]
      }
    });
  }

  const testPreset: InterviewPreset = {
    id: 'mid-level',
    name: 'Test',
    questionCount: 20,
    durationMinutes: 30,
    difficultyDistribution: { beginner: 20, intermediate: 60, advanced: 20 },
    topicIds: ['b1', 'i1', 'a1']
  };

  it('redistributes when ONE difficulty is short', () => {
    // quota 4/12/4; intermediate can only supply 5 → 7 short.
    const repository = shortBank({ beginner: 30, intermediate: 5, advanced: 30 });
    const snapshot = buildPresetAssessment(testPreset, repository, seeded());

    expect(snapshot.questions).toHaveLength(20);
    const counts = { b1: 0, i1: 0, a1: 0 };
    for (const q of snapshot.questions) counts[q.sourceQuizId as keyof typeof counts]++;
    expect(counts.i1).toBe(5);
    expect(counts.b1 + counts.a1).toBe(15);
  });

  it('redistributes when MULTIPLE difficulties are short', () => {
    const repository = shortBank({ beginner: 2, intermediate: 3, advanced: 40 });
    const snapshot = buildPresetAssessment(testPreset, repository, seeded());

    expect(snapshot.questions).toHaveLength(20);
    const counts = { b1: 0, i1: 0, a1: 0 };
    for (const q of snapshot.questions) counts[q.sourceQuizId as keyof typeof counts]++;
    expect(counts.b1).toBe(2);
    expect(counts.i1).toBe(3);
    expect(counts.a1).toBe(15);
  });

  it('THROWS when the whole bank cannot supply the count', () => {
    const repository = shortBank({ beginner: 3, intermediate: 3, advanced: 3 });
    try {
      buildPresetAssessment(testPreset, repository, seeded());
      throw new Error('expected failure');
    } catch (err) {
      const error = err as AssessmentBuildError;
      expect(error.code).toBe('INSUFFICIENT_QUESTIONS');
      expect(error.message).toMatch(/needs 20 questions but only 9 are available/);
      expect(error.message).not.toMatch(/\?|Because/);   // no question content
    }
  });

  it('a zero-weighted band is NOT counted as available capacity', () => {
    const juniorLike: InterviewPreset = {
      ...testPreset,
      difficultyDistribution: { beginner: 60, intermediate: 40, advanced: 0 }
    };
    // 100 advanced questions exist, but advanced is weighted 0% → unusable.
    const repository = shortBank({ beginner: 3, intermediate: 3, advanced: 100 });
    expect(() => buildPresetAssessment(juniorLike, repository, seeded()))
      .toThrow(/only 6 are available/);
  });
});

describe('source immutability', () => {
  it('leaves the repository untouched across builds', () => {
    const repository = repo();
    const before = repository.getQuizById('typescript')!.questions.map((q) => q.questionId);

    buildPresetAssessment(preset('senior'), repository, seededRandomSource(1));
    buildPresetAssessment(preset('senior'), repository, seededRandomSource(2));

    expect(repository.getQuizById('typescript')!.questions.map((q) => q.questionId)).toEqual(before);
  });

  it('same seed still reproduces after an earlier build', () => {
    const repository = repo();
    buildPresetAssessment(preset('junior'), repository, seededRandomSource(3));
    const a = buildPresetAssessment(preset('junior'), repository, seededRandomSource(44));
    const b = buildPresetAssessment(preset('junior'), repository, seededRandomSource(44));
    expect(a.questions.map((q) => q.questionId)).toEqual(b.questions.map((q) => q.questionId));
  });
});

describe('resolved preset values are authoritative', () => {
  it.each(['junior', 'mid-level', 'senior'])('%s resolves count, duration and quotas', (id) => {
    const resolved = resolvePreset(preset(id));
    expect(resolved.presetId).toBe(id);
    expect(resolved.durationSeconds).toBe(preset(id).durationMinutes * 60);
    expect(resolved.questionCount).toBe(preset(id).questionCount);
    expect(
      resolved.difficultyQuotas.beginner +
      resolved.difficultyQuotas.intermediate +
      resolved.difficultyQuotas.advanced
    ).toBe(resolved.questionCount);
  });

  it('rejects a preset whose duration would be unusable', () => {
    expect(() => resolvePreset({ ...preset('junior'), durationMinutes: 0 }))
      .toThrow(/invalid duration/i);
  });
});
