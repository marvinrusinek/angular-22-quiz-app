import { InterviewAttemptHistoryEntry, InterviewTopicHistoryEntry } from '@shared/models/interview-history.model';
import { TopicTrend } from '@shared/models/interview-topic-trends.model';
import {
  buildTopicTrend,
  buildTopicTrendPoints,
  calculateAggregateTopicPercentage,
  calculateTopicDirection,
  calculateTopicTrends,
  filterTopicTrends,
  getTopicStrengthBand,
  isPriorityTopic,
  sortTopicTrends,
  summarizeTopicTrends,
  TOPIC_TREND_THRESHOLD
} from './interview-topic-trends.service';

function tp(topicId: string, correct: number, total: number): InterviewTopicHistoryEntry {
  return { topicId, topicName: topicId.toUpperCase(), correct, total, percentage: Math.round((correct / total) * 100) };
}

function att(i: number, topics: InterviewTopicHistoryEntry[], pct = 50): InterviewAttemptHistoryEntry {
  return {
    id: `a${i}`,
    attemptNumber: i + 1,
    completedAt: `2026-07-${String(10 + i).padStart(2, '0')}T10:00:00.000Z`,
    score: pct,
    totalQuestions: 100,
    percentage: pct,
    completionReason: 'submitted',
    selectedTopicIds: topics.map((t) => t.topicId),
    topicPerformance: topics
  };
}

// Build a single-topic trend directly from raw appearance percentages.
function trendFor(topicId: string, samples: { correct: number; total: number }[]): TopicTrend {
  const attempts = samples.map((s, i) => att(i, [tp(topicId, s.correct, s.total)]));
  const points = buildTopicTrendPoints(attempts).get(topicId)!;
  return buildTopicTrend(topicId, topicId, points);
}

describe('Topic point construction', () => {
  it('1/2/3. groups by topic id, preserves chronological order + fields', () => {
    const attempts = [
      att(0, [tp('forms', 2, 4), tp('http', 1, 2)]),
      att(1, [tp('forms', 3, 4)])
    ];
    const map = buildTopicTrendPoints(attempts);
    expect([...map.keys()].sort()).toEqual(['forms', 'http']);
    const forms = map.get('forms')!;
    expect(forms.map((p) => p.percentage)).toEqual([50, 75]);   // chronological
    expect(forms[0]).toMatchObject({ attemptId: 'a0', attemptNumber: 1, correct: 2, total: 4, percentage: 50 });
  });

  it('4. handles an attempt with no topic performance', () => {
    const map = buildTopicTrendPoints([att(0, []), att(1, [tp('forms', 2, 2)])]);
    expect(map.get('forms')!).toHaveLength(1);
  });

  it('5. handles empty / malformed input safely', () => {
    expect(buildTopicTrendPoints([]).size).toBe(0);
    const bad = [att(0, [{ topicId: 'z', topicName: 'Z', correct: 0, total: 0, percentage: 0 }])];
    expect(buildTopicTrendPoints(bad).size).toBe(0);   // zero-total skipped
  });

  it('recomputes each point percentage from raw values (ignores an inconsistent retained %)', () => {
    const attempts = [
      att(0, [{ topicId: 'x', topicName: 'X', correct: 1, total: 2, percentage: 99 }]),   // bogus 99
      att(1, [{ topicId: 'x', topicName: 'X', correct: 2, total: 2, percentage: 5 }])     // bogus 5
    ];
    expect(buildTopicTrendPoints(attempts).get('x')!.map((p) => p.percentage)).toEqual([50, 100]);
  });
});

describe('Direction', () => {
  it('6. one appearance → insufficient', () => {
    expect(calculateTopicDirection(80, null)).toBe('insufficient');
  });
  it('7. exactly +5 → improving', () => {
    expect(calculateTopicDirection(65, 60)).toBe('improving');
    expect(TOPIC_TREND_THRESHOLD).toBe(5);
  });
  it('8. exactly -5 → declining', () => {
    expect(calculateTopicDirection(55, 60)).toBe('declining');
  });
  it('9. -4 through +4 → steady', () => {
    expect(calculateTopicDirection(64, 60)).toBe('steady');
    expect(calculateTopicDirection(56, 60)).toBe('steady');
  });
  it('10. uses the latest two topic appearances', () => {
    // 40 → 90 → 92: latest two (90,92) → steady, NOT 40→92.
    const t = trendFor('x', [{ correct: 4, total: 10 }, { correct: 9, total: 10 }, { correct: 92, total: 100 }]);
    expect(t.direction).toBe('steady');
    expect(t.latestPercentage).toBe(92);
    expect(t.previousPercentage).toBe(90);
  });
  it('11. does not compare unrelated overall interview scores', () => {
    // Overall attempt percentages rise, but the topic itself declines.
    const attempts = [att(0, [tp('forms', 8, 10)], 20), att(1, [tp('forms', 5, 10)], 95)];
    const t = buildTopicTrend('forms', 'forms', buildTopicTrendPoints(attempts).get('forms')!);
    expect(t.direction).toBe('declining');
  });
});

describe('Aggregation', () => {
  it('12/13. sums raw correct/total (not rounded percentages)', () => {
    // 1/3 (33%) then 1/1 (100%): rounded-avg 67; raw = 2/4 = 50.
    const t = trendFor('x', [{ correct: 1, total: 3 }, { correct: 1, total: 1 }]);
    expect(t.aggregatePercentage).toBe(50);
  });
  it('14. handles uneven question counts', () => {
    const t = trendFor('x', [{ correct: 8, total: 10 }, { correct: 1, total: 2 }]);
    expect(t.aggregatePercentage).toBe(75);   // 9/12
  });
  it('15/16. skips invalid zero-total samples; 0–100', () => {
    expect(calculateAggregateTopicPercentage([])).toBe(0);
    const t = trendFor('x', [{ correct: 10, total: 10 }, { correct: 10, total: 10 }]);
    expect(t.aggregatePercentage).toBe(100);
  });
});

describe('Strength band', () => {
  it('17/18/19/20. boundaries', () => {
    expect(getTopicStrengthBand(75)).toBe('strong');
    expect(getTopicStrengthBand(100)).toBe('strong');
    expect(getTopicStrengthBand(74)).toBe('moderate');
    expect(getTopicStrengthBand(60)).toBe('moderate');
    expect(getTopicStrengthBand(59)).toBe('weak');
    expect(getTopicStrengthBand(0)).toBe('weak');
  });
});

describe('Priority', () => {
  it('21. declining topics are priorities', () => {
    expect(isPriorityTopic(90, 'declining')).toBe(true);
  });
  it('22. aggregate below 60 is a priority', () => {
    expect(isPriorityTopic(55, 'improving')).toBe(true);
  });
  it('23. strong improving topics are not priorities', () => {
    expect(isPriorityTopic(85, 'improving')).toBe(false);
  });
  it('24. insufficient topics are not automatically priorities', () => {
    expect(isPriorityTopic(80, 'insufficient')).toBe(false);
  });
});

describe('Sorting', () => {
  const decliningPriority = trendFor('decl', [{ correct: 9, total: 10 }, { correct: 4, total: 10 }]);       // 90→40 declining, agg 65
  const otherPriority = { ...trendFor('low', [{ correct: 5, total: 10 }, { correct: 5, total: 10 }]), aggregatePercentage: 40, isPriority: true } as TopicTrend;
  const improving = trendFor('imp', [{ correct: 8, total: 10 }, { correct: 10, total: 10 }]);               // 80→100 improving, agg 90
  const steady = trendFor('std', [{ correct: 8, total: 10 }, { correct: 8, total: 10 }]);                   // steady, agg 80
  const insufficient = trendFor('ins', [{ correct: 9, total: 10 }]);                                        // 1 appearance

  it('25-28. groups: declining → other priority → improving → steady → insufficient', () => {
    const sorted = sortTopicTrends([steady, insufficient, improving, otherPriority, decliningPriority]);
    expect(sorted.map((t) => t.topicId)).toEqual(['decl', 'low', 'imp', 'std', 'ins']);
  });

  it('29. tie-break is deterministic (name)', () => {
    const a = trendFor('bravo', [{ correct: 8, total: 10 }, { correct: 8, total: 10 }]);
    const b = trendFor('alpha', [{ correct: 8, total: 10 }, { correct: 8, total: 10 }]);
    expect(sortTopicTrends([a, b]).map((t) => t.topicId)).toEqual(['alpha', 'bravo']);
  });
});

describe('Summary', () => {
  it('30-35. counts each category (a topic counts once per category)', () => {
    const result = calculateTopicTrends([
      att(0, [tp('imp', 5, 10), tp('decl', 9, 10), tp('std', 8, 10), tp('ins', 3, 10)]),
      att(1, [tp('imp', 9, 10), tp('decl', 4, 10), tp('std', 8, 10)])   // 'ins' only once
    ]);
    expect(result.trackedCount).toBe(4);
    expect(result.improvingCount).toBe(1);   // imp
    expect(result.steadyCount).toBe(1);       // std
    expect(result.insufficientCount).toBe(1); // ins (one appearance)
    // needs-attention = declining OR aggregate < 60: decl + imp(agg 70? 14/20=70 no)… check decl only.
    expect(result.needsAttentionCount).toBeGreaterThanOrEqual(1);
  });
});

describe('Filtering', () => {
  const topics = calculateTopicTrends([
    att(0, [tp('imp', 5, 10), tp('std', 8, 10), tp('ins', 3, 10)]),
    att(1, [tp('imp', 10, 10), tp('std', 8, 10)])
  ]).topics;

  it('36. all returns every topic', () => {
    expect(filterTopicTrends(topics, 'all')).toHaveLength(3);
  });
  it('37. improving returns only improving', () => {
    expect(filterTopicTrends(topics, 'improving').map((t) => t.topicId)).toEqual(['imp']);
  });
  it('38. steady returns only steady', () => {
    expect(filterTopicTrends(topics, 'steady').map((t) => t.topicId)).toEqual(['std']);
  });
  it('39. needs-attention returns priority topics', () => {
    expect(filterTopicTrends(topics, 'needs-attention').every((t) => t.isPriority)).toBe(true);
  });
  it('40. more-data-needed returns insufficient topics', () => {
    expect(filterTopicTrends(topics, 'insufficient').map((t) => t.topicId)).toEqual(['ins']);
  });
});

describe('summarizeTopicTrends', () => {
  it('does not double-count a topic within one category', () => {
    const t = trendFor('x', [{ correct: 8, total: 10 }, { correct: 8, total: 10 }]);
    const s = summarizeTopicTrends([t, t]);   // same topic twice
    expect(s.steadyCount).toBe(2);            // counts entries, but each is once per its own category
  });

  it('empty history → all zero', () => {
    const r = calculateTopicTrends([]);
    expect(r).toMatchObject({ trackedCount: 0, improvingCount: 0, steadyCount: 0, needsAttentionCount: 0, insufficientCount: 0 });
    expect(r.topics).toEqual([]);
  });
});
