import { InterviewAttemptHistoryEntry } from '@shared/models/interview-history.model';

/**
 * Generic aggregation of retained Interview History topic performance by topic —
 * a NEUTRAL, shared helper (used by both Interview Readiness and Topic Trends).
 * It sums RAW correct/total across attempts (never averaging pre-rounded
 * percentages), so a topic can't look strong purely from one tiny sample.
 */
export interface AggregatedTopic {
  topicId: string;
  topicName: string;
  correct: number;
  total: number;
  percentage: number;   // raw: correct/total across ALL attempts (0–100)
}

/** Aggregate topicPerformance history by topic (raw correct/total sums). */
export function aggregateTopicPercentages(
  attempts: readonly InterviewAttemptHistoryEntry[]
): AggregatedTopic[] {
  const map = new Map<string, { topicName: string; correct: number; total: number }>();
  for (const a of attempts) {
    for (const t of a.topicPerformance) {
      if (!(t.total > 0)) continue;   // skip empty/invalid topic samples
      const cur = map.get(t.topicId) ?? { topicName: t.topicName, correct: 0, total: 0 };
      cur.correct += t.correct;
      cur.total += t.total;
      cur.topicName = t.topicName || cur.topicName;
      map.set(t.topicId, cur);
    }
  }
  return [...map.entries()].map(([topicId, v]) => ({
    topicId,
    topicName: v.topicName,
    correct: v.correct,
    total: v.total,
    percentage: v.total > 0 ? (v.correct / v.total) * 100 : 0
  }));
}
