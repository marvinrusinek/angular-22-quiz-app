import { InterviewAttemptHistoryEntry } from '@shared/models';
import { aggregateTopicPercentages } from './interview-topic-history';
// Regression: the readiness service re-exports the SAME helper — proving the
// extraction left Readiness's aggregation untouched.
import { aggregateTopicPercentages as fromReadiness } from '@shared/services/features/interview/interview-readiness.service';

function attempt(topics: { id: string; correct: number; total: number }[]): InterviewAttemptHistoryEntry {
  return {
    id: 'a',
    completedAt: '2026-07-10T10:00:00.000Z',
    score: 0,
    totalQuestions: 10,
    percentage: 0,
    completionReason: 'submitted',
    selectedTopicIds: topics.map((t) => t.id),
    topicPerformance: topics.map((t) => ({ topicId: t.id, topicName: t.id.toUpperCase(), correct: t.correct, total: t.total, percentage: 0 }))
  };
}

describe('aggregateTopicPercentages (shared)', () => {
  const attempts = [
    attempt([{ id: 'a', correct: 1, total: 3 }, { id: 'b', correct: 4, total: 5 }]),
    attempt([{ id: 'a', correct: 1, total: 1 }])
  ];

  it('sums raw correct/total by topic (no rounded-percentage averaging)', () => {
    const byId = new Map(aggregateTopicPercentages(attempts).map((t) => [t.topicId, t]));
    expect(byId.get('a')).toMatchObject({ correct: 2, total: 4, percentage: 50 });   // not (33+100)/2
    expect(byId.get('b')).toMatchObject({ correct: 4, total: 5, percentage: 80 });
  });

  it('is the exact same function the readiness service exposes (no behaviour drift)', () => {
    expect(fromReadiness).toBe(aggregateTopicPercentages);
    expect(fromReadiness(attempts)).toEqual(aggregateTopicPercentages(attempts));
  });

  it('skips zero-total samples', () => {
    expect(aggregateTopicPercentages([attempt([{ id: 'z', correct: 0, total: 0 }])])).toEqual([]);
  });
});
