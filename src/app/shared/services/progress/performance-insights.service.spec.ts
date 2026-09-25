import { TestBed } from '@angular/core/testing';

import { InterviewHistoryService } from '@shared/services/features/interview/interview-history.service';
import type { SanitizedAttemptInput } from '@shared/services/interview/interview-result-history.adapter';
import { PerformanceInsightsService } from './performance-insights.service';
import { TopicPerformanceHistoryService } from './topic-performance-history.service';
import { WeakAreasService } from './weak-areas.service';

interface Stack {
  topic: TopicPerformanceHistoryService;
  interview: InterviewHistoryService;
  weak: WeakAreasService;
  insights: PerformanceInsightsService;
}

function stack(): Stack {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({});
  return {
    topic: TestBed.inject(TopicPerformanceHistoryService),
    interview: TestBed.inject(InterviewHistoryService),
    weak: TestBed.inject(WeakAreasService),
    insights: TestBed.inject(PerformanceInsightsService)
  };
}

function interviewAttempt(over: Partial<SanitizedAttemptInput> = {}): SanitizedAttemptInput {
  return {
    sessionId: 'is_1',
    completedAt: '2026-08-01T12:00:00.000Z',
    score: 7,
    totalQuestions: 10,
    percentage: 70,
    completionReason: 'submitted',
    answered: 10,
    unanswered: 0,
    incorrect: 3,
    durationSeconds: 900,
    timeUsedSeconds: 540,
    submittedByExpiry: false,
    focusChanges: 0,
    configKind: 'custom',
    configuredDifficulty: 'mixed',
    selectedTopicIds: ['rxjs', 'forms'],
    topicPerformance: [
      { topicId: 'rxjs', topicName: 'RxJS', correct: 2, total: 5, percentage: 40 },
      { topicId: 'forms', topicName: 'Forms', correct: 5, total: 5, percentage: 100 }
    ],
    ...over
  };
}

/** Every key/value currently in localStorage and sessionStorage. */
function storageSnapshot(): string {
  const dump = (s: Storage): Record<string, string | null> =>
    Object.fromEntries(Object.keys(s).sort().map((k) => [k, s.getItem(k)]));
  return JSON.stringify({ local: dump(localStorage), session: dump(sessionStorage) });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  jest.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe('PerformanceInsightsService — derives from the existing stores', () => {
  it('is empty with no history', () => {
    const { insights } = stack();
    expect(insights.insights()).toEqual({
      hasData: false, topicQuiz: null, interview: null, practice: null, topics: [], strongest: [], needsReview: []
    });
  });

  it('reads all three sources and keeps them separate', () => {
    const s = stack();
    s.topic.record('quiz:rxjs:1', 'topic-quiz', [{ topicId: 'rxjs', topicName: 'RxJS', correct: 9, total: 10 }]);
    s.topic.record('practice:p1', 'weak-areas-practice', [{ topicId: 'rxjs', topicName: 'RxJS', correct: 1, total: 4 }]);
    s.interview.recordAttempt(interviewAttempt());

    const out = s.insights.insights();
    expect(out.topicQuiz).toMatchObject({ source: 'topic-quiz', attempts: 1, correct: 9, total: 10, accuracyPct: 90 });
    expect(out.practice).toMatchObject({ source: 'weak-areas-practice', attempts: 1, correct: 1, total: 4, accuracyPct: 25 });
    expect(out.interview).toMatchObject({ source: 'interview', attempts: 1, correct: 7, total: 10, accuracyPct: 70 });
    expect(out.hasData).toBe(true);
  });

  it('shows only the sources that have data', () => {
    const s = stack();
    s.topic.record('quiz:rxjs:1', 'topic-quiz', [{ topicId: 'rxjs', correct: 3, total: 4 }]);
    const out = s.insights.insights();
    expect(out.topicQuiz).not.toBeNull();
    expect(out.interview).toBeNull();
    expect(out.practice).toBeNull();
  });

  it('counts a multi-topic practice run as ONE attempt', () => {
    const s = stack();
    s.topic.record('practice:p1', 'weak-areas-practice', [
      { topicId: 'rxjs', correct: 1, total: 2 },
      { topicId: 'forms', correct: 1, total: 2 },
      { topicId: 'http', correct: 1, total: 2 }
    ]);
    expect(s.insights.insights().practice).toMatchObject({ attempts: 1, correct: 3, total: 6 });
  });

  it('builds topics from the SAME merged dataset Weak Areas judges', () => {
    const s = stack();
    s.interview.recordAttempt(interviewAttempt());
    s.topic.record('quiz:rxjs:1', 'topic-quiz', [{ topicId: 'rxjs', topicName: 'RxJS', correct: 1, total: 5 }]);

    const rxjs = s.insights.insights().topics.find((t) => t.topicId === 'rxjs')!;
    // interview 2/5 + quiz 1/5, exactly what WeakAreasService aggregates.
    expect(rxjs).toMatchObject({ correct: 3, total: 10, percentage: 30 });
    expect(s.weak.weakTopics()[0]).toMatchObject({ topicId: 'rxjs', correct: 3, total: 10 });
  });

  it('passes Needs Review through from WeakAreasService unchanged', () => {
    const s = stack();
    s.interview.recordAttempt(interviewAttempt());
    expect(s.insights.insights().needsReview).toEqual(s.weak.weakTopics());
    expect(s.insights.insights().needsReview.map((t) => t.topicId)).toEqual(['rxjs']);
  });

  it('never lists a Needs Review topic as Strongest', () => {
    const s = stack();
    s.interview.recordAttempt(interviewAttempt());
    const { needsReview, strongest } = s.insights.insights();
    expect(needsReview.map((t) => t.topicId)).toEqual(['rxjs']);
    expect(strongest.map((t) => t.topicId)).toEqual(['forms']);
    const weak = new Set(needsReview.map((t) => t.topicId));
    expect(strongest.some((t) => weak.has(t.topicId))).toBe(false);
  });

  it('updates reactively when history changes, without being recreated', () => {
    const s = stack();
    expect(s.insights.insights().topicQuiz).toBeNull();

    s.topic.record('quiz:rxjs:1', 'topic-quiz', [{ topicId: 'rxjs', correct: 2, total: 4 }]);
    expect(s.insights.insights().topicQuiz).toMatchObject({ attempts: 1, correct: 2, total: 4 });

    s.topic.record('quiz:rxjs:2', 'topic-quiz', [{ topicId: 'rxjs', correct: 4, total: 4 }]);
    expect(s.insights.insights().topicQuiz).toMatchObject({ attempts: 2, correct: 6, total: 8, accuracyPct: 75 });

    s.interview.recordAttempt(interviewAttempt());
    expect(s.insights.insights().interview).not.toBeNull();
  });

  it('a re-recorded attempt does not inflate anything (dedupe is upstream and intact)', () => {
    const s = stack();
    s.topic.record('quiz:rxjs:1', 'topic-quiz', [{ topicId: 'rxjs', correct: 2, total: 4 }]);
    s.topic.record('quiz:rxjs:1', 'topic-quiz', [{ topicId: 'rxjs', correct: 2, total: 4 }]);
    s.interview.recordAttempt(interviewAttempt());
    s.interview.recordAttempt(interviewAttempt());

    const out = s.insights.insights();
    expect(out.topicQuiz).toMatchObject({ attempts: 1, total: 4 });
    expect(out.interview).toMatchObject({ attempts: 1, total: 10 });
  });

  it('returns the same object until a history changes (a computed, not a recalculation per read)', () => {
    const s = stack();
    s.topic.record('quiz:rxjs:1', 'topic-quiz', [{ topicId: 'rxjs', correct: 2, total: 4 }]);
    expect(s.insights.insights()).toBe(s.insights.insights());
  });
});

describe('PerformanceInsightsService — read-only guarantees', () => {
  it('writes nothing and creates no storage key, however often it is read', () => {
    const s = stack();
    s.topic.record('quiz:rxjs:1', 'topic-quiz', [{ topicId: 'rxjs', correct: 2, total: 4 }]);
    s.topic.record('practice:p1', 'weak-areas-practice', [{ topicId: 'forms', correct: 3, total: 4 }]);
    s.interview.recordAttempt(interviewAttempt());

    const before = storageSnapshot();
    const setItem = jest.spyOn(Storage.prototype, 'setItem');
    const removeItem = jest.spyOn(Storage.prototype, 'removeItem');
    const clear = jest.spyOn(Storage.prototype, 'clear');

    for (let i = 0; i < 5; i++) {
      s.insights.insights();
    }

    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(storageSnapshot()).toBe(before);
  });

  it('adds no localStorage key beyond the two history stores it reads', () => {
    const s = stack();
    s.topic.record('quiz:rxjs:1', 'topic-quiz', [{ topicId: 'rxjs', correct: 2, total: 4 }]);
    s.interview.recordAttempt(interviewAttempt());
    s.insights.insights();

    expect(Object.keys(localStorage).sort()).toEqual([
      'interviewAttemptHistory:v2',
      'topicPerformanceHistory:v1'
    ]);
    expect(Object.keys(sessionStorage)).toEqual([]);
  });

  it('does not mutate the history records it reads', () => {
    const s = stack();
    s.topic.record('quiz:rxjs:1', 'topic-quiz', [{ topicId: 'rxjs', correct: 2, total: 4 }]);
    s.interview.recordAttempt(interviewAttempt());

    const before = JSON.stringify({ t: s.topic.records(), i: s.interview.history(), m: s.weak.mergedAttempts() });
    s.insights.insights();
    expect(JSON.stringify({ t: s.topic.records(), i: s.interview.history(), m: s.weak.mergedAttempts() })).toBe(before);
  });

  it('is not a weaker or different Weak Areas: WeakAreasService output is identical with it present', () => {
    const s = stack();
    s.interview.recordAttempt(interviewAttempt());
    const before = JSON.stringify(s.weak.weakTopics());
    s.insights.insights();
    expect(JSON.stringify(s.weak.weakTopics())).toBe(before);
  });

  it('exposes no answer data anywhere in its output', () => {
    const s = stack();
    s.topic.record('quiz:rxjs:1', 'topic-quiz', [{ topicId: 'rxjs', correct: 2, total: 4 }]);
    s.interview.recordAttempt(interviewAttempt());
    const json = JSON.stringify(s.insights.insights());
    for (const banned of [
      'questionText', 'option', 'explanation', 'correctOptionIds', 'selectedOptionIds', 'answerKey', 'sessionToken'
    ]) {
      expect(json).not.toContain(banned);
    }
  });
});
