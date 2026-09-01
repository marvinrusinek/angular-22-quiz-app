import {
  CUSTOM_INTERVIEW_LABEL,
  findInterviewPreset,
  INTERVIEW_PRESETS,
  interviewConfigLabel,
  InterviewPreset,
  validateInterviewPresets
} from './interview-preset.model';
import { isValidDistribution } from '../utils/difficulty-quota';
import { getQuizData } from '../quiz-data-cache';
// S6p (Angular Stage 14): src/assets/data/quiz.json was deleted — see
// shared/testing/quiz-catalog-fixture.json (test-only, never bundled).
import quizData from '../testing/quiz-catalog-fixture.json';

// The real catalog, read the same way the app reads it.
const catalog = ((quizData as { quizzes?: unknown[] }).quizzes ?? quizData) as {
  quizId: string;
  difficulty?: string;
}[];

describe('INTERVIEW_PRESETS — configuration integrity', () => {
  it('preset ids are unique', () => {
    const ids = INTERVIEW_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every difficulty distribution is nonnegative and totals 100', () => {
    for (const preset of INTERVIEW_PRESETS) {
      expect(isValidDistribution(preset.difficultyDistribution)).toBe(true);
    }
  });

  it('every configured topic id exists in the real question bank', () => {
    const known = new Set(catalog.map((q) => q.quizId));
    for (const preset of INTERVIEW_PRESETS) {
      for (const topicId of preset.topicIds) {
        expect({ preset: preset.id, topicId, known: known.has(topicId) })
          .toEqual({ preset: preset.id, topicId, known: true });
      }
    }
  });

  it('ships the documented question counts and durations', () => {
    expect(findInterviewPreset('junior')).toMatchObject({ questionCount: 15, durationMinutes: 20 });
    expect(findInterviewPreset('mid-level')).toMatchObject({ questionCount: 20, durationMinutes: 30 });
    expect(findInterviewPreset('senior')).toMatchObject({ questionCount: 25, durationMinutes: 40 });
  });

  it('preset configuration is immutable (frozen at every level)', () => {
    expect(Object.isFrozen(INTERVIEW_PRESETS)).toBe(true);
    for (const preset of INTERVIEW_PRESETS) {
      expect(Object.isFrozen(preset)).toBe(true);
      expect(Object.isFrozen(preset.difficultyDistribution)).toBe(true);
      expect(Object.isFrozen(preset.topicIds)).toBe(true);
      // A stray write must not corrupt the shared definition.
      expect(() => {
        (preset as unknown as { questionCount: number }).questionCount = 999;
      }).toThrow();
      expect(preset.questionCount).not.toBe(999);
    }
  });

  it('does not reference a security topic, which the bank does not contain', () => {
    const known = new Set(catalog.map((q) => q.quizId));
    expect([...known].some((id) => /secur/i.test(id))).toBe(false);
    for (const preset of INTERVIEW_PRESETS) {
      expect(preset.topicIds.some((id) => /secur/i.test(id))).toBe(false);
    }
  });
});

describe('validateInterviewPresets', () => {
  it('reports unknown topic ids', () => {
    const bad: InterviewPreset = {
      id: 'junior', name: 'x', shortLabel: 'x', description: 'x', questionCount: 5, durationMinutes: 5,
      difficultyDistribution: { beginner: 100, intermediate: 0, advanced: 0 },
      topicIds: ['no-such-topic']
    };
    const issues = validateInterviewPresets(catalog, [bad]);
    expect(issues.some((i) => i.problem.includes('unknown topic id'))).toBe(true);
  });

  it('reports a distribution that does not total 100', () => {
    const bad: InterviewPreset = {
      id: 'junior', name: 'x', shortLabel: 'x', description: 'x', questionCount: 5, durationMinutes: 5,
      difficultyDistribution: { beginner: 50, intermediate: 40, advanced: 0 },
      topicIds: ['typescript']
    };
    expect(validateInterviewPresets(catalog, [bad]).some((i) => i.problem.includes('total 100'))).toBe(true);
  });

  it('reports duplicate ids', () => {
    const one = INTERVIEW_PRESETS[0];
    expect(validateInterviewPresets(catalog, [one, one]).some((i) => i.problem === 'duplicate preset id')).toBe(true);
  });

  // KNOWN, DELIBERATE: Senior weights 10% beginner but configures no beginner
  // topic, so that quota cannot be filled from its own topics and the builder
  // redistributes it. Pinned so the trade-off stays visible rather than silent.
  it('flags Senior: 10% beginner weight with no beginner topic configured', () => {
    const issues = validateInterviewPresets(catalog);
    const senior = issues.filter((i) => i.presetId === 'senior');
    expect(senior).toEqual([
      { presetId: 'senior', problem: '10% weighted to "beginner" but no beginner topic is configured' }
    ]);
  });

  it('Junior and Mid-Level have no configuration issues', () => {
    const issues = validateInterviewPresets(catalog);
    expect(issues.filter((i) => i.presetId === 'junior')).toEqual([]);
    expect(issues.filter((i) => i.presetId === 'mid-level')).toEqual([]);
  });
});

describe('interviewConfigLabel', () => {
  it('labels preset attempts with the preset name', () => {
    expect(interviewConfigLabel('preset', 'mid-level')).toBe('Mid-Level Angular Developer');
  });

  it('prefers the snapshot taken at completion over the live definition', () => {
    expect(interviewConfigLabel('preset', 'junior', 'Junior Angular Developer (2026)'))
      .toBe('Junior Angular Developer (2026)');
  });

  it('treats custom, missing and unrecognisable records as Custom Interview', () => {
    expect(interviewConfigLabel('custom', undefined)).toBe(CUSTOM_INTERVIEW_LABEL);
    expect(interviewConfigLabel(undefined, undefined)).toBe(CUSTOM_INTERVIEW_LABEL);
    expect(interviewConfigLabel('preset', 'retired-preset')).toBe(CUSTOM_INTERVIEW_LABEL);
  });
});
