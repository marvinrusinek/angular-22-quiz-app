import { TestBed } from '@angular/core/testing';

import { TopicPerformanceHistoryService } from './topic-performance-history.service';
import { SK_TOPIC_PERFORMANCE_HISTORY } from '@shared/constants/session-keys';

/**
 * Attempt-ID stability for topic-quiz recording.
 *
 * The id is `quiz:{quizId}:{completedAt}`. `completedAt` is stamped ONCE when a
 * FinalResult is first built and then persisted in the sessionStorage snapshot,
 * so a Results remount or a browser refresh reads the SAME timestamp back rather
 * than generating a new one. These tests pin that contract at the store level:
 * the same id must collapse to one record, and genuinely separate completions
 * must not.
 */
function service(): TopicPerformanceHistoryService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [TopicPerformanceHistoryService] });
  return TestBed.inject(TopicPerformanceHistoryService);
}

const attemptIdFor = (quizId: string, completedAt: number): string =>
  `quiz:${quizId}:${completedAt}`;

const topics = (correct: number, total: number) => [
  { topicId: 'rxjs', topicName: 'RxJS', correct, total }
];

describe('topic-quiz attempt id — stability and collisions', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('revisiting the SAME completed result records exactly one attempt', () => {
    const svc = service();
    const completedAt = 1_722_000_000_000;             // stamped once at completion
    const id = attemptIdFor('rxjs', completedAt);

    svc.record(id, 'topic-quiz', topics(3, 10));       // first arrival on Results
    svc.record(id, 'topic-quiz', topics(3, 10));       // navigate away and back
    svc.record(id, 'topic-quiz', topics(3, 10));       // and again

    expect(svc.records()).toHaveLength(1);
    expect(svc.records()[0]).toMatchObject({ correct: 3, total: 10 });
  });

  it('refreshing/remounting Results records exactly one attempt', () => {
    const completedAt = 1_722_000_000_000;
    const id = attemptIdFor('rxjs', completedAt);

    service().record(id, 'topic-quiz', topics(3, 10));

    // A refresh constructs a NEW service instance, which reloads from storage.
    // The snapshot preserves completedAt, so the id is unchanged.
    const afterRefresh = service();
    expect(afterRefresh.records()).toHaveLength(1);
    afterRefresh.record(id, 'topic-quiz', topics(3, 10));
    expect(afterRefresh.records()).toHaveLength(1);

    // Persisted state agrees — the dedup is durable, not in-memory.
    const stored = JSON.parse(localStorage.getItem(SK_TOPIC_PERFORMANCE_HISTORY) ?? '{}');
    expect(stored.records).toHaveLength(1);
  });

  it('two GENUINELY separate completions of the same quiz record two attempts', () => {
    const svc = service();
    svc.record(attemptIdFor('rxjs', 1_722_000_000_000), 'topic-quiz', topics(3, 10));
    svc.record(attemptIdFor('rxjs', 1_722_000_600_000), 'topic-quiz', topics(8, 10));   // 10 min later

    expect(svc.records()).toHaveLength(2);
    // Both count toward the aggregate: 11/20 overall.
    const totals = svc.records().reduce(
      (acc, r) => ({ correct: acc.correct + r.correct, total: acc.total + r.total }),
      { correct: 0, total: 0 }
    );
    expect(totals).toEqual({ correct: 11, total: 20 });
  });

  it('attempts completed close together do NOT collide', () => {
    const svc = service();
    // One millisecond apart is the tightest the timestamp can distinguish, and
    // is already far tighter than a human can complete two quizzes.
    svc.record(attemptIdFor('rxjs', 1_722_000_000_000), 'topic-quiz', topics(1, 5));
    svc.record(attemptIdFor('rxjs', 1_722_000_000_001), 'topic-quiz', topics(2, 5));
    expect(svc.records()).toHaveLength(2);
  });

  it('the same instant on DIFFERENT quizzes never collides', () => {
    const svc = service();
    const sameInstant = 1_722_000_000_000;
    svc.record(attemptIdFor('rxjs', sameInstant), 'topic-quiz', [
      { topicId: 'rxjs', correct: 1, total: 5 }
    ]);
    svc.record(attemptIdFor('signals', sameInstant), 'topic-quiz', [
      { topicId: 'signals', correct: 2, total: 5 }
    ]);
    expect(svc.records().map((r) => r.topicId)).toEqual(['rxjs', 'signals']);
  });

  it('recording is independent of achievements — it stands alone', () => {
    // The store has no achievement dependency at all; recording succeeds with
    // nothing else configured. This is the store-level half of the guarantee
    // that an achievement early-return cannot suppress weak-area data.
    const svc = service();
    svc.record(attemptIdFor('rxjs', 1_722_000_000_000), 'topic-quiz', topics(3, 10));
    expect(svc.records()).toHaveLength(1);
  });
});
