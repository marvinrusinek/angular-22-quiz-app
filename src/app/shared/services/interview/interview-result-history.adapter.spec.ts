import { toSanitizedAttempt } from './interview-result-history.adapter';
import type { InterviewResultViewModel } from '../../models/interview/interview-view-models';

/**
 * The adapter is the ONE place a backend result becomes durable local data, so
 * it is where "no answer key on disk" is enforced and tested.
 */
function result(over: Partial<InterviewResultViewModel> = {}): InterviewResultViewModel {
  return {
    sessionId: 'is_1',
    submittedAtMs: Date.parse('2026-08-01T12:00:00.000Z'),
    submittedByExpiry: false,
    total: 10, answered: 9, unanswered: 1, correct: 7, incorrect: 2, percentage: 70,
    durationSeconds: 900, timeUsedSeconds: 540,
    config: { mode: 'custom', difficulty: 'beginner', topicIds: ['rxjs', 'signals'], questionCount: 10 },
    byTopic: [
      { topicId: 'rxjs', title: 'RxJS', correct: 4, incorrect: 1, unanswered: 0, total: 5, percentage: 80 },
      { topicId: 'signals', title: 'Signals', correct: 3, incorrect: 1, unanswered: 1, total: 5, percentage: 60 }
    ],
    review: [
      {
        questionId: 'rxjs:q:0', sourceQuizId: 'rxjs', questionText: 'Which operator flattens?',
        type: 'single',
        options: [{ optionId: 1, text: 'switchMap' }, { optionId: 2, text: 'tap' }],
        selectedOptionIds: [1], correctOptionIds: [1],
        explanation: 'switchMap cancels the previous inner observable.',
        isCorrect: true, isAnswered: true, flagged: false
      }
    ],
    ...over
  };
}

describe('field mapping', () => {
  it('copies backend values verbatim and never recalculates', () => {
    // A deliberately INCONSISTENT percentage: the backend's number wins even
    // when a local calculation would disagree.
    const attempt = toSanitizedAttempt(result({ percentage: 42 }), 0);

    expect(attempt).toMatchObject({
      sessionId: 'is_1',
      completedAt: '2026-08-01T12:00:00.000Z',
      score: 7,               // backend correct → score
      totalQuestions: 10,     // backend total   → totalQuestions
      percentage: 42,         // copied, NOT 7/10
      answered: 9,
      unanswered: 1,
      incorrect: 2,
      durationSeconds: 900,
      timeUsedSeconds: 540,
      submittedByExpiry: false,
      completionReason: 'submitted'
    });
  });

  it('maps submittedByExpiry onto the completion reason', () => {
    expect(toSanitizedAttempt(result({ submittedByExpiry: true }), 0).completionReason)
      .toBe('time-expired');
  });

  it('maps per-topic buckets using the FROZEN backend titles', () => {
    const attempt = toSanitizedAttempt(result(), 0);
    expect(attempt.topicPerformance).toEqual([
      { topicId: 'rxjs', topicName: 'RxJS', correct: 4, total: 5, percentage: 80, incorrect: 1, unanswered: 0 },
      { topicId: 'signals', topicName: 'Signals', correct: 3, total: 5, percentage: 60, incorrect: 1, unanswered: 1 }
    ]);
  });
});

describe('difficulty and preset rule', () => {
  it('a CUSTOM attempt keeps its configured difficulty and gets no preset name', () => {
    const attempt = toSanitizedAttempt(result(), 0);
    expect(attempt.configKind).toBe('custom');
    expect(attempt.configuredDifficulty).toBe('beginner');
    expect(attempt.presetId).toBeUndefined();
    expect(attempt.presetName).toBeUndefined();
  });

  it('a PRESET attempt gets no invented difficulty', () => {
    // A role preset mixes difficulties by design; recording one would make
    // History claim the attempt was e.g. entirely "Beginner".
    const attempt = toSanitizedAttempt(
      result({ config: { mode: 'preset', presetId: 'junior', difficulty: 'beginner', topicIds: ['rxjs'], questionCount: 10 } }),
      0
    );
    expect(attempt.configKind).toBe('preset');
    expect(attempt.configuredDifficulty).toBeUndefined();
    expect(attempt.presetId).toBe('junior');
    expect(attempt.presetName).toBeTruthy();
  });

  it('falls back to the preset id when the preset is no longer defined', () => {
    const attempt = toSanitizedAttempt(
      result({ config: { mode: 'preset', presetId: 'retired-preset', topicIds: ['rxjs'], questionCount: 10 } }),
      0
    );
    expect(attempt.presetName).toBe('retired-preset');
  });
});

describe('client-observed focus changes', () => {
  it('is carried through as an aggregate integer only', () => {
    expect(toSanitizedAttempt(result(), 4).focusChanges).toBe(4);
    expect(toSanitizedAttempt(result(), -3).focusChanges).toBe(0);
    expect(toSanitizedAttempt(result(), 2.7).focusChanges).toBe(2);
  });

  it('does not alter any backend field', () => {
    const withFocus = toSanitizedAttempt(result(), 9);
    const withoutFocus = toSanitizedAttempt(result(), 0);
    const { focusChanges: _a, ...restA } = withFocus;
    const { focusChanges: _b, ...restB } = withoutFocus;
    expect(restA).toEqual(restB);
  });
});

describe('sanitization', () => {
  it('carries NO questions, options, answers, correctness or explanations', () => {
    const serialized = JSON.stringify(toSanitizedAttempt(result(), 3));

    for (const banned of [
      'review', 'questions', 'options', 'selectedOptionIds', 'correctOptionIds',
      'explanation', 'answerKey', 'sessionToken', 'questionText',
      'switchMap', 'cancels the previous'
    ]) {
      expect(serialized).not.toContain(banned);
    }
  });

  it('exposes only the expected top-level keys', () => {
    expect(Object.keys(toSanitizedAttempt(result(), 1)).sort()).toEqual([
      'answered', 'completedAt', 'completionReason', 'configKind', 'configuredDifficulty',
      'durationSeconds', 'focusChanges', 'incorrect', 'percentage', 'presetId', 'presetName',
      'score', 'selectedTopicIds', 'sessionId', 'submittedByExpiry', 'timeUsedSeconds',
      'topicPerformance', 'totalQuestions', 'unanswered'
    ]);
  });
});
