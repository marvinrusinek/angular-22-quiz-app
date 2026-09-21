import { TestBed } from '@angular/core/testing';

import { TopicPerformanceHistoryService } from './topic-performance-history.service';
import { SK_TOPIC_PERFORMANCE_HISTORY } from '../../constants/session-keys';
import { calculateWeakTopics, TopicAttemptLike } from '../../utils/weak-areas';

function service(): TopicPerformanceHistoryService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [TopicPerformanceHistoryService] });
  return TestBed.inject(TopicPerformanceHistoryService);
}

const stored = (): unknown =>
  JSON.parse(localStorage.getItem(SK_TOPIC_PERFORMANCE_HISTORY) ?? 'null');

describe('TopicPerformanceHistoryService — recording', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('records an attempt once and exposes it for aggregation', () => {
    const svc = service();
    svc.record('att-1', 'topic-quiz', [{ topicId: 'rxjs', topicName: 'RxJS', correct: 2, total: 10 }]);

    expect(svc.records()).toHaveLength(1);
    expect(svc.records()[0]).toMatchObject({
      attemptId: 'att-1', source: 'topic-quiz', topicId: 'rxjs', correct: 2, total: 10
    });
    expect(svc.asAttempts()[0].topicPerformance[0]).toMatchObject({ correct: 2, total: 10 });
  });

  it('DEDUPES by attemptId — remount, refresh and revisit record nothing new', () => {
    const svc = service();
    const topics = [{ topicId: 'rxjs', correct: 2, total: 10 }];

    svc.record('att-1', 'topic-quiz', topics);
    svc.record('att-1', 'topic-quiz', topics);   // Results remount
    svc.record('att-1', 'topic-quiz', topics);   // revisit
    expect(svc.records()).toHaveLength(1);
    expect(svc.hasRecorded('att-1')).toBe(true);

    // A fresh service instance (i.e. a page reload) still refuses the duplicate,
    // because the check runs against PERSISTED state, not an in-memory flag.
    const reloaded = service();
    expect(reloaded.records()).toHaveLength(1);
    reloaded.record('att-1', 'topic-quiz', topics);
    expect(reloaded.records()).toHaveLength(1);
  });

  it('records one row per topic for a multi-topic attempt', () => {
    const svc = service();
    svc.record('att-1', 'weak-areas-practice', [
      { topicId: 'rxjs', correct: 1, total: 4 },
      { topicId: 'signals', correct: 3, total: 6 }
    ]);
    expect(svc.records()).toHaveLength(2);
    expect(svc.records().every((r) => r.attemptId === 'att-1')).toBe(true);
  });

  it('never destroys valid older entries when appending', () => {
    const svc = service();
    svc.record('att-1', 'topic-quiz', [{ topicId: 'rxjs', correct: 1, total: 5 }]);
    svc.record('att-2', 'weak-areas-practice', [{ topicId: 'signals', correct: 2, total: 5 }]);
    expect(svc.records().map((r) => r.attemptId)).toEqual(['att-1', 'att-2']);
  });

  it('ignores empty, zero-total and malformed inputs', () => {
    const svc = service();
    svc.record('', 'topic-quiz', [{ topicId: 'rxjs', correct: 1, total: 5 }]);      // no id
    svc.record('att-1', 'topic-quiz', []);                                          // no topics
    svc.record('att-2', 'topic-quiz', [{ topicId: 'rxjs', correct: 0, total: 0 }]);  // empty sample
    svc.record('att-3', 'topic-quiz', [{ topicId: '', correct: 1, total: 5 }]);      // no topic id
    expect(svc.records()).toEqual([]);
    expect(stored()).toBeNull();   // nothing was written at all
  });

  it('clamps a nonsensical correct > total rather than discarding the record', () => {
    const svc = service();
    svc.record('att-1', 'topic-quiz', [{ topicId: 'rxjs', correct: 99, total: 10 }]);
    expect(svc.records()[0]).toMatchObject({ correct: 10, total: 10 });
  });
});

describe('TopicPerformanceHistoryService — read-only records() accessor', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    jest.useRealTimers();
    localStorage.clear();
  });

  /** Run a mutation a caller might attempt; whether it throws or is ignored is irrelevant. */
  const attempt = (mutation: () => void): void => {
    try {
      mutation();
    } catch {
      // Frozen data throws in strict mode. The assertions below check the OUTCOME.
    }
  };

  it('exposes source, attemptId, completedAt and raw counts for both sources', () => {
    jest.useFakeTimers({ now: new Date('2026-09-01T10:00:00.000Z') });
    const svc = service();
    svc.record('quiz:rxjs:1', 'topic-quiz', [{ topicId: 'rxjs', topicName: 'RxJS', correct: 4, total: 5 }]);
    svc.record('practice:p1', 'weak-areas-practice', [{ topicId: 'signals', topicName: 'Signals', correct: 1, total: 3 }]);

    expect(svc.records()).toEqual([
      { attemptId: 'quiz:rxjs:1', source: 'topic-quiz', completedAt: '2026-09-01T10:00:00.000Z', topicId: 'rxjs', topicName: 'RxJS', correct: 4, total: 5 },
      { attemptId: 'practice:p1', source: 'weak-areas-practice', completedAt: '2026-09-01T10:00:00.000Z', topicId: 'signals', topicName: 'Signals', correct: 1, total: 3 }
    ]);
  });

  it('keeps `source` on records loaded from storage', () => {
    localStorage.setItem(SK_TOPIC_PERFORMANCE_HISTORY, JSON.stringify({
      version: 1,
      records: [
        { attemptId: 'a', source: 'topic-quiz', completedAt: '2026-07-01T10:00:00.000Z', topicId: 'rxjs', topicName: 'RxJS', correct: 1, total: 5 },
        { attemptId: 'b', source: 'weak-areas-practice', completedAt: '2026-07-02T10:00:00.000Z', topicId: 'rxjs', topicName: 'RxJS', correct: 2, total: 5 }
      ]
    }));
    expect(service().records().map((r) => [r.attemptId, r.source])).toEqual([
      ['a', 'topic-quiz'],
      ['b', 'weak-areas-practice']
    ]);
  });

  it('cannot be corrupted by a caller mutating the returned array or its records', () => {
    const svc = service();
    svc.record('a1', 'topic-quiz', [{ topicId: 'rxjs', topicName: 'RxJS', correct: 1, total: 4 }]);

    const rows = svc.records() as unknown as Record<string, unknown>[];
    attempt(() => rows.push({ attemptId: 'INJECTED', source: 'topic-quiz', completedAt: '2026-07-01T10:00:00.000Z', topicId: 't', topicName: 't', correct: 9, total: 9 }));
    attempt(() => { rows[0]!['correct'] = 4; });
    attempt(() => { rows[0]!['source'] = 'weak-areas-practice'; });
    attempt(() => { rows.length = 0; });
    attempt(() => rows.splice(0, 1));

    expect(Object.isFrozen(svc.records())).toBe(true);
    expect(Object.isFrozen(svc.records()[0])).toBe(true);
    expect(svc.records()).toHaveLength(1);
    expect(svc.records()[0]).toMatchObject({ attemptId: 'a1', source: 'topic-quiz', correct: 1, total: 4 });

    // The decisive check: the NEXT write persists a clean store.
    svc.record('a2', 'topic-quiz', [{ topicId: 'rxjs', topicName: 'RxJS', correct: 2, total: 4 }]);
    const persisted = stored() as { records: { attemptId: string; correct: number; source: string }[] };
    expect(persisted.records.map((r) => r.attemptId)).toEqual(['a1', 'a2']);
    expect(persisted.records[0]).toMatchObject({ correct: 1, source: 'topic-quiz' });
  });

  it('protects records that were LOADED from storage, not just freshly recorded ones', () => {
    localStorage.setItem(SK_TOPIC_PERFORMANCE_HISTORY, JSON.stringify({
      version: 1,
      records: [{ attemptId: 'a', source: 'topic-quiz', completedAt: '2026-07-01T10:00:00.000Z', topicId: 'rxjs', topicName: 'RxJS', correct: 1, total: 5 }]
    }));
    const svc = service();
    const rows = svc.records() as unknown as Record<string, unknown>[];
    attempt(() => { rows[0]!['correct'] = 5; });
    attempt(() => rows.push({}));

    expect(Object.isFrozen(svc.records())).toBe(true);
    expect(svc.records()).toHaveLength(1);
    expect(svc.records()[0]!.correct).toBe(1);
  });

  it('leaves asAttempts() working — it derives fresh objects, never the frozen records', () => {
    const svc = service();
    svc.record('a1', 'topic-quiz', [{ topicId: 'rxjs', topicName: 'RxJS', correct: 3, total: 4 }]);
    const attempts = svc.asAttempts();
    expect(attempts[0]!.topicPerformance[0]).toMatchObject({ topicId: 'rxjs', correct: 3, total: 4, percentage: 75 });
    expect(Object.isFrozen(attempts[0])).toBe(false);
  });

  it('persists byte-for-byte the same JSON as before — freezing changes nothing on disk', () => {
    jest.useFakeTimers({ now: new Date('2026-09-01T10:00:00.000Z') });
    const svc = service();
    svc.record('quiz:rxjs:1', 'topic-quiz', [{ topicId: 'rxjs', topicName: 'RxJS', correct: 4, total: 5 }]);
    svc.record('practice:p1', 'weak-areas-practice', [
      { topicId: 'signals', topicName: 'Signals', correct: 1, total: 3 },
      { topicId: 'forms', topicName: 'Forms', correct: 2, total: 2 }
    ]);

    const expected = JSON.stringify({
      version: 1,
      records: [
        { attemptId: 'quiz:rxjs:1', source: 'topic-quiz', completedAt: '2026-09-01T10:00:00.000Z', topicId: 'rxjs', topicName: 'RxJS', correct: 4, total: 5 },
        { attemptId: 'practice:p1', source: 'weak-areas-practice', completedAt: '2026-09-01T10:00:00.000Z', topicId: 'signals', topicName: 'Signals', correct: 1, total: 3 },
        { attemptId: 'practice:p1', source: 'weak-areas-practice', completedAt: '2026-09-01T10:00:00.000Z', topicId: 'forms', topicName: 'Forms', correct: 2, total: 2 }
      ]
    });
    expect(localStorage.getItem(SK_TOPIC_PERFORMANCE_HISTORY)).toBe(expected);
  });

  it('retains the 200-record cap and still appends after freezing', () => {
    const svc = service();
    for (let i = 0; i < 205; i++) {
      svc.record(`a-${i}`, 'topic-quiz', [{ topicId: 'rxjs', correct: 1, total: 2 }]);
    }
    expect(svc.records()).toHaveLength(200);
    expect(svc.records()[0]!.attemptId).toBe('a-5');
    expect(svc.records()[199]!.attemptId).toBe('a-204');
  });
});

describe('TopicPerformanceHistoryService — resilient loading', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('survives malformed storage without throwing', () => {
    localStorage.setItem(SK_TOPIC_PERFORMANCE_HISTORY, '{ not json');
    expect(() => service()).not.toThrow();
    expect(service().records()).toEqual([]);
  });

  it('keeps the GOOD records when some stored entries are malformed', () => {
    localStorage.setItem(SK_TOPIC_PERFORMANCE_HISTORY, JSON.stringify({
      version: 1,
      records: [
        null,
        { attemptId: 'good', source: 'topic-quiz', completedAt: '2026-07-01T10:00:00.000Z', topicId: 'rxjs', topicName: 'RxJS', correct: 1, total: 5 },
        { attemptId: 'bad-source', source: 'interview', completedAt: '2026-07-01T10:00:00.000Z', topicId: 'x', correct: 1, total: 5 },
        { attemptId: 'no-date', source: 'topic-quiz', completedAt: 'nope', topicId: 'x', correct: 1, total: 5 },
        { attemptId: 'zero', source: 'topic-quiz', completedAt: '2026-07-01T10:00:00.000Z', topicId: 'x', correct: 0, total: 0 }
      ]
    }));
    const svc = service();
    expect(svc.records().map((r) => r.attemptId)).toEqual(['good']);
  });

  it('accepts a bare array (legacy shape) as well as the versioned envelope', () => {
    localStorage.setItem(SK_TOPIC_PERFORMANCE_HISTORY, JSON.stringify([
      { attemptId: 'legacy', source: 'topic-quiz', completedAt: '2026-07-01T10:00:00.000Z', topicId: 'rxjs', correct: 1, total: 5 }
    ]));
    expect(service().records().map((r) => r.attemptId)).toEqual(['legacy']);
  });

  it('de-duplicates hand-edited storage on load', () => {
    const row = { attemptId: 'dup', source: 'topic-quiz', completedAt: '2026-07-01T10:00:00.000Z', topicId: 'rxjs', correct: 1, total: 5 };
    localStorage.setItem(SK_TOPIC_PERFORMANCE_HISTORY, JSON.stringify({ version: 1, records: [row, row, row] }));
    expect(service().records()).toHaveLength(1);
  });
});

describe('Weak areas — merging sources without double-counting', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  const interviewAttempt = (completedAt: string, correct: number, total: number): TopicAttemptLike => ({
    completedAt,
    topicPerformance: [{ topicId: 'rxjs', topicName: 'RxJS', correct, total, percentage: (correct / total) * 100 }]
  });

  it('merges interview + topic-quiz + practice through ONE accuracy formula', () => {
    const svc = service();
    svc.record('quiz-1', 'topic-quiz', [{ topicId: 'rxjs', correct: 1, total: 5 }]);
    svc.record('practice-1', 'weak-areas-practice', [{ topicId: 'rxjs', correct: 2, total: 5 }]);

    const merged = [interviewAttempt('2026-07-01T10:00:00.000Z', 1, 10), ...svc.asAttempts()];
    const weak = calculateWeakTopics(merged);

    // Raw sums across ALL three sources: (1+1+2)/(10+5+5) = 4/20 = 20%.
    expect(weak).toHaveLength(1);
    expect(weak[0]).toMatchObject({ topicId: 'rxjs', correct: 4, total: 20 });
    expect(weak[0].percentage).toBeCloseTo(20, 5);
  });

  it('a re-recorded attempt does NOT inflate the merged aggregate', () => {
    const svc = service();
    svc.record('quiz-1', 'topic-quiz', [{ topicId: 'rxjs', correct: 1, total: 5 }]);
    const before = calculateWeakTopics(svc.asAttempts())[0];

    svc.record('quiz-1', 'topic-quiz', [{ topicId: 'rxjs', correct: 1, total: 5 }]);   // duplicate
    const after = calculateWeakTopics(svc.asAttempts())[0];

    expect(after).toEqual(before);
    expect(after).toMatchObject({ correct: 1, total: 5 });
  });

  it('practice results feed back in, so improvement can clear a weak topic', () => {
    const svc = service();
    // Start weak: 1/10 = 10%.
    const weakBefore = calculateWeakTopics([interviewAttempt('2026-07-01T10:00:00.000Z', 1, 10)]);
    expect(weakBefore.map((t) => t.topicId)).toEqual(['rxjs']);

    // A strong practice run lifts the raw aggregate above the threshold.
    svc.record('practice-1', 'weak-areas-practice', [{ topicId: 'rxjs', correct: 40, total: 40 }]);
    const merged = [interviewAttempt('2026-07-01T10:00:00.000Z', 1, 10), ...svc.asAttempts()];
    // (1+40)/(10+40) = 82% → no longer weak.
    expect(calculateWeakTopics(merged)).toEqual([]);
  });
});
