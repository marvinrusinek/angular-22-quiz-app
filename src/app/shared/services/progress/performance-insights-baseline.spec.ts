import { TestBed } from '@angular/core/testing';

import {
  SK_INTERVIEW_HISTORY,
  SK_TOPIC_PERFORMANCE_HISTORY
} from '@shared/constants/session-keys';
import {
  TOPIC_PERFORMANCE_HISTORY_MAX,
  TOPIC_PERFORMANCE_HISTORY_VERSION
} from '@shared/models/topic-performance-history.model';
import { INTERVIEW_HISTORY_MAX } from '@shared/models/interview-history.model';
import {
  calculateWeakTopics,
  WEAK_AREA_MAX_TOPICS,
  WEAK_AREA_MIN_ANSWERED,
  WEAK_AREA_THRESHOLD
} from '@shared/utils/weak-areas';
import { InterviewHistoryService } from '@shared/services/features/interview/interview-history.service';
import type { SanitizedAttemptInput } from '@shared/services/interview/interview-result-history.adapter';
import { TopicPerformanceHistoryService } from './topic-performance-history.service';
import { WeakAreasService } from './weak-areas.service';

/**
 * BASELINE PINS for the stores Performance Insights will READ.
 *
 * These describe behaviour that exists today and must not change as a side
 * effect of the Performance Insights work. They deliberately exercise the real
 * services against real (jsdom) localStorage rather than mocks, so a change to
 * write behaviour, retention, dedupe or the persisted shape fails here first.
 *
 * Nothing in this file asserts anything about Performance Insights itself.
 */

const NOW = new Date('2026-09-01T10:00:00.000Z');

interface Stack {
  topic: TopicPerformanceHistoryService;
  interview: InterviewHistoryService;
  weak: WeakAreasService;
}

/** One TestBed for all three, so WeakAreasService sees the SAME store instances. */
function stack(): Stack {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({});
  return {
    topic: TestBed.inject(TopicPerformanceHistoryService),
    interview: TestBed.inject(InterviewHistoryService),
    weak: TestBed.inject(WeakAreasService)
  };
}

const persistedTopic = (): { version: number; records: Record<string, unknown>[] } =>
  JSON.parse(localStorage.getItem(SK_TOPIC_PERFORMANCE_HISTORY) ?? 'null');

/** A sanitized interview attempt, exactly as the result adapter produces it. */
function sanitized(over: Partial<SanitizedAttemptInput> = {}): SanitizedAttemptInput {
  return {
    sessionId: 'is_1',
    completedAt: '2026-08-01T12:00:00.000Z',
    score: 7,
    totalQuestions: 10,
    percentage: 70,
    completionReason: 'submitted',
    answered: 9,
    unanswered: 1,
    incorrect: 2,
    durationSeconds: 900,
    timeUsedSeconds: 540,
    submittedByExpiry: false,
    focusChanges: 0,
    configKind: 'custom',
    configuredDifficulty: 'beginner',
    selectedTopicIds: ['rxjs'],
    topicPerformance: [
      { topicId: 'rxjs', topicName: 'RxJS', correct: 4, total: 5, percentage: 80, incorrect: 1, unanswered: 0 }
    ],
    ...over
  };
}

beforeEach(() => {
  localStorage.clear();
  jest.useFakeTimers({ now: NOW });
});

afterEach(() => {
  jest.useRealTimers();
  localStorage.clear();
});

describe('BASELINE — topic performance history', () => {
  it('retains `source` per record and keeps the two sources distinguishable', () => {
    const { topic } = stack();
    topic.record('quiz:rxjs:1', 'topic-quiz', [{ topicId: 'rxjs', topicName: 'RxJS', correct: 4, total: 5 }]);
    topic.record('practice:p1', 'weak-areas-practice', [{ topicId: 'rxjs', topicName: 'RxJS', correct: 1, total: 2 }]);

    expect(topic.records().map((r) => [r.attemptId, r.source])).toEqual([
      ['quiz:rxjs:1', 'topic-quiz'],
      ['practice:p1', 'weak-areas-practice']
    ]);
  });

  it('keeps attemptId, completedAt and raw counts intact through persistence and reload', () => {
    const first = stack();
    first.topic.record('quiz:signals:9', 'topic-quiz', [
      { topicId: 'signals', topicName: 'Signals', correct: 7, total: 10 }
    ]);

    const reloaded = stack().topic;
    expect(reloaded.records()).toEqual([
      {
        attemptId: 'quiz:signals:9',
        source: 'topic-quiz',
        completedAt: NOW.toISOString(),
        topicId: 'signals',
        topicName: 'Signals',
        correct: 7,
        total: 10
      }
    ]);
  });

  it('writes exactly { version, records[] } with exactly the seven record fields', () => {
    const { topic } = stack();
    topic.record('a1', 'topic-quiz', [{ topicId: 'rxjs', topicName: 'RxJS', correct: 3, total: 4 }]);

    const store = persistedTopic();
    expect(Object.keys(store).sort()).toEqual(['records', 'version']);
    expect(store.version).toBe(TOPIC_PERFORMANCE_HISTORY_VERSION);
    expect(Object.keys(store.records[0]!).sort()).toEqual(
      ['attemptId', 'completedAt', 'correct', 'source', 'topicId', 'topicName', 'total']
    );
  });

  it('stamps one completedAt for every topic row of a multi-topic attempt', () => {
    const { topic } = stack();
    topic.record('practice:p1', 'weak-areas-practice', [
      { topicId: 'rxjs', correct: 1, total: 4 },
      { topicId: 'signals', correct: 3, total: 6 },
      { topicId: 'forms', correct: 2, total: 2 }
    ]);
    const stamps = new Set(topic.records().map((r) => r.completedAt));
    expect(topic.records()).toHaveLength(3);
    expect(stamps.size).toBe(1);
  });

  it('caps retention at 200 RECORDS, dropping the oldest', () => {
    const { topic } = stack();
    expect(TOPIC_PERFORMANCE_HISTORY_MAX).toBe(200);

    for (let i = 0; i <= TOPIC_PERFORMANCE_HISTORY_MAX; i++) {
      topic.record(`a-${i}`, 'topic-quiz', [{ topicId: 'rxjs', correct: 1, total: 2 }]);
    }

    // 201 recorded (a-0..a-200); a-0 dropped.
    expect(topic.records()).toHaveLength(200);
    expect(topic.records()[0]!.attemptId).toBe('a-1');
    expect(topic.records()[199]!.attemptId).toBe('a-200');
    expect(persistedTopic().records).toHaveLength(200);
    expect(stack().topic.records()).toHaveLength(200);
  });

  it('applies the same cap when loading an over-long stored history', () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({
      attemptId: `old-${i}`,
      source: 'topic-quiz',
      completedAt: '2026-07-01T10:00:00.000Z',
      topicId: 'rxjs',
      topicName: 'RxJS',
      correct: 1,
      total: 2
    }));
    localStorage.setItem(
      SK_TOPIC_PERFORMANCE_HISTORY,
      JSON.stringify({ version: TOPIC_PERFORMANCE_HISTORY_VERSION, records: rows })
    );

    const { topic } = stack();
    expect(topic.records()).toHaveLength(200);
    expect(topic.records()[0]!.attemptId).toBe('old-50');
    expect(topic.records()[199]!.attemptId).toBe('old-249');
  });

  it('the cap counts RECORDS, not attempts — a multi-topic attempt can be cut in half', () => {
    // KNOWN, PRE-EXISTING behaviour that any attempt-level reconstruction must
    // tolerate: 70 three-topic attempts = 210 rows, so the oldest attempt loses
    // ten rows' worth and only some of its topics survive.
    const { topic } = stack();
    for (let i = 0; i < 70; i++) {
      topic.record(`p-${i}`, 'weak-areas-practice', [
        { topicId: 't1', correct: 1, total: 2 },
        { topicId: 't2', correct: 1, total: 2 },
        { topicId: 't3', correct: 1, total: 2 }
      ]);
    }
    expect(topic.records()).toHaveLength(200);
    const surviving = topic.records().filter((r) => r.attemptId === 'p-3');
    expect(surviving.length).toBeGreaterThan(0);
    expect(surviving.length).toBeLessThan(3);
    expect(topic.records().some((r) => r.attemptId === 'p-0')).toBe(false);
  });

  it('never writes to the Interview History key', () => {
    const { topic } = stack();
    topic.record('a1', 'topic-quiz', [{ topicId: 'rxjs', correct: 1, total: 2 }]);
    expect(localStorage.getItem(SK_INTERVIEW_HISTORY)).toBeNull();
  });
});

describe('BASELINE — Interview history', () => {
  it('stores correct, total, percentage, timestamp and the topic breakdown verbatim', () => {
    const { interview } = stack();
    interview.recordAttempt(sanitized({
      sessionId: 'is_9',
      completedAt: '2026-08-09T09:30:00.000Z',
      score: 6,
      totalQuestions: 8,
      percentage: 75,
      topicPerformance: [
        { topicId: 'rxjs', topicName: 'RxJS', correct: 2, total: 4, percentage: 50, incorrect: 1, unanswered: 1 },
        { topicId: 'forms', topicName: 'Forms', correct: 4, total: 4, percentage: 100, incorrect: 0, unanswered: 0 }
      ]
    }));

    const [entry] = stack().interview.history();   // through a reload
    expect(entry).toMatchObject({
      sessionId: 'is_9',
      completedAt: '2026-08-09T09:30:00.000Z',
      score: 6,
      totalQuestions: 8,
      percentage: 75
    });
    expect(entry!.topicPerformance).toEqual([
      { topicId: 'rxjs', topicName: 'RxJS', correct: 2, total: 4, percentage: 50, incorrect: 1, unanswered: 1 },
      { topicId: 'forms', topicName: 'Forms', correct: 4, total: 4, percentage: 100, incorrect: 0, unanswered: 0 }
    ]);
  });

  it('caps the recordAttempt path at 20 attempts and dedupes by sessionId across a reload', () => {
    const { interview } = stack();
    expect(INTERVIEW_HISTORY_MAX).toBe(20);

    for (let i = 1; i <= INTERVIEW_HISTORY_MAX + 1; i++) {
      interview.recordAttempt(sanitized({
        sessionId: `is_${i}`,
        completedAt: new Date(Date.UTC(2026, 7, i)).toISOString()
      }));
    }
    expect(interview.history()).toHaveLength(20);
    expect(interview.history()[0]!.sessionId).toBe('is_2');
    expect(interview.history()[19]!.sessionId).toBe('is_21');

    const reloaded = stack().interview;
    reloaded.recordAttempt(sanitized({ sessionId: 'is_21' }));   // the same session again
    expect(reloaded.history()).toHaveLength(20);
    expect(reloaded.history().filter((e) => e.sessionId === 'is_21')).toHaveLength(1);
  });

  it('never writes to the Topic Performance key', () => {
    const { interview } = stack();
    interview.recordAttempt(sanitized());
    expect(localStorage.getItem(SK_TOPIC_PERFORMANCE_HISTORY)).toBeNull();
  });
});

describe('BASELINE — WeakAreasService (Needs Review authority)', () => {
  /**
   * rxjs   : interview 1/10 + quiz 2/5             = 3/15  = 20%   → weak
   * signals: interview 2/2  + quiz 1/2             = 3/4   = 75%   → weak
   * forms  : interview 9/10 + practice 1/2         = 10/12 = 83.3% → NOT weak
   */
  function seedMixed(s: Stack): void {
    s.interview.recordAttempt(sanitized({
      sessionId: 'is_1',
      completedAt: '2026-08-01T12:00:00.000Z',
      topicPerformance: [
        { topicId: 'rxjs', topicName: 'RxJS', correct: 1, total: 10, percentage: 10 },
        { topicId: 'signals', topicName: 'Signals', correct: 2, total: 2, percentage: 100 },
        { topicId: 'forms', topicName: 'Forms', correct: 9, total: 10, percentage: 90 }
      ]
    }));
    s.topic.record('quiz:rxjs:1', 'topic-quiz', [{ topicId: 'rxjs', topicName: 'RxJS', correct: 2, total: 5 }]);
    s.topic.record('quiz:signals:1', 'topic-quiz', [{ topicId: 'signals', topicName: 'Signals', correct: 1, total: 2 }]);
    s.topic.record('practice:p1', 'weak-areas-practice', [{ topicId: 'forms', topicName: 'Forms', correct: 1, total: 2 }]);
  }

  it('merges Interview + Topic Quiz + Practice, interview attempts first', () => {
    const s = stack();
    seedMixed(s);

    const merged = s.weak.mergedAttempts();
    expect(merged).toHaveLength(1 + 3);                       // 1 interview attempt + 3 topic rows
    expect(merged[0]!.topicPerformance).toHaveLength(3);      // the interview attempt leads
  });

  it('produces the current Needs Review output: weakest first, raw sums across every source', () => {
    const s = stack();
    seedMixed(s);

    const weak = s.weak.weakTopics();
    expect(weak.map((t) => t.topicId)).toEqual(['rxjs', 'signals']);
    expect(weak[0]).toMatchObject({ topicId: 'rxjs', correct: 3, total: 15, incorrect: 12 });
    expect(weak[0]!.percentage).toBeCloseTo(20, 5);
    expect(weak[1]).toMatchObject({ topicId: 'signals', correct: 3, total: 4, incorrect: 1 });
    expect(weak[1]!.percentage).toBeCloseTo(75, 5);

    // The service adds NOTHING to the pure calculation.
    expect(weak).toEqual(calculateWeakTopics(s.weak.mergedAttempts()));
    expect(s.weak.weakTopicIds()).toEqual(['rxjs', 'signals']);
    expect(s.weak.hasWeakTopics()).toBe(true);
  });

  it('keeps its thresholds: 80% exclusive, 3 answered minimum, at most 3 topics', () => {
    expect(WEAK_AREA_THRESHOLD).toBe(80);
    expect(WEAK_AREA_MIN_ANSWERED).toBe(3);
    expect(WEAK_AREA_MAX_TOPICS).toBe(3);
  });

  it('pools the minimum-sample across sources (2 + 2 answered makes 4)', () => {
    const s = stack();
    s.interview.recordAttempt(sanitized({
      topicPerformance: [{ topicId: 'http', topicName: 'HTTP', correct: 0, total: 2, percentage: 0 }]
    }));
    expect(s.weak.weakTopics()).toEqual([]);                  // 2 answered: not judgeable yet

    s.topic.record('quiz:http:1', 'topic-quiz', [{ topicId: 'http', topicName: 'HTTP', correct: 1, total: 2 }]);
    expect(s.weak.weakTopics().map((t) => t.topicId)).toEqual(['http']);   // 1/4, now judgeable
  });

  it('reports insufficient data only until some topic reaches the minimum sample', () => {
    const s = stack();
    expect(s.weak.hasInsufficientData()).toBe(true);          // no history at all
    expect(s.weak.weakTopics()).toEqual([]);

    s.topic.record('quiz:rxjs:1', 'topic-quiz', [{ topicId: 'rxjs', correct: 2, total: 2 }]);
    expect(s.weak.hasInsufficientData()).toBe(true);          // 2 answered < 3

    s.topic.record('quiz:rxjs:2', 'topic-quiz', [{ topicId: 'rxjs', correct: 2, total: 2 }]);
    expect(s.weak.hasInsufficientData()).toBe(false);         // 4 answered, and 100% is fine
    expect(s.weak.hasWeakTopics()).toBe(false);
  });

  it('reacts to new records without being re-created', () => {
    const s = stack();
    s.topic.record('quiz:rxjs:1', 'topic-quiz', [{ topicId: 'rxjs', correct: 0, total: 5 }]);
    expect(s.weak.weakTopicIds()).toEqual(['rxjs']);

    s.topic.record('practice:p1', 'weak-areas-practice', [{ topicId: 'rxjs', correct: 45, total: 45 }]);
    expect(s.weak.weakTopicIds()).toEqual([]);                // 45/50 = 90%
  });
});
