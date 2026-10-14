import {
  calculateWeakTopics,
  TopicAttemptLike,
  WEAK_AREA_MAX_TOPICS,
  WEAK_AREA_MIN_ANSWERED,
  WEAK_AREA_THRESHOLD
} from './weak-areas';

type TopicSpec = [topicId: string, correct: number, total: number];

function attempt(completedAt: string, topics: TopicSpec[]): TopicAttemptLike {
  return {
    completedAt,
    topicPerformance: topics.map(([topicId, correct, total]) => ({
      topicId,
      topicName: topicId.toUpperCase(),
      correct,
      total,
      percentage: total > 0 ? (correct / total) * 100 : 0
    }))
  };
}

const ids = (ts: { topicId: string }[]): string[] => ts.map((t) => t.topicId);

describe('calculateWeakTopics — eligibility', () => {
  it('returns nothing when there are no stored attempts', () => {
    expect(calculateWeakTopics([])).toEqual([]);
  });

  it('never classifies an UNATTEMPTED topic as weak', () => {
    // Only 'rxjs' was attempted; every other topic is absent from the data.
    const weak = calculateWeakTopics([attempt('2026-07-01T10:00:00.000Z', [['rxjs', 1, 10]])]);
    expect(ids(weak)).toEqual(['rxjs']);
  });

  it('requires at least the minimum answered questions', () => {
    // 2 answered → not enough to judge, even at 0%.
    expect(calculateWeakTopics([attempt('2026-07-01T10:00:00.000Z', [['rxjs', 0, 2]])])).toEqual(
      []
    );
    // 3 answered → now eligible.
    const weak = calculateWeakTopics([attempt('2026-07-01T10:00:00.000Z', [['rxjs', 0, 3]])]);
    expect(ids(weak)).toEqual(['rxjs']);
    expect(WEAK_AREA_MIN_ANSWERED).toBe(3);
  });

  it('accumulates answered counts ACROSS attempts to reach the minimum', () => {
    // 2 + 2 = 4 answered overall, so the topic becomes judgeable.
    const weak = calculateWeakTopics([
      attempt('2026-07-01T10:00:00.000Z', [['rxjs', 0, 2]]),
      attempt('2026-07-02T10:00:00.000Z', [['rxjs', 1, 2]])
    ]);
    expect(ids(weak)).toEqual(['rxjs']);
    expect(weak[0]).toMatchObject({ correct: 1, total: 4, incorrect: 3 });
  });

  it('includes a topic below the threshold and EXCLUDES one at exactly 80%', () => {
    const weak = calculateWeakTopics([
      attempt('2026-07-01T10:00:00.000Z', [
        ['below', 7, 10], // 70% → weak
        ['exactly', 8, 10], // 80% → NOT weak (boundary is exclusive)
        ['above', 9, 10] // 90% → not weak
      ])
    ]);
    expect(ids(weak)).toEqual(['below']);
    expect(WEAK_AREA_THRESHOLD).toBe(80);
  });

  it('uses RAW summed correct/total, not an average of per-attempt percentages', () => {
    // Averaging percentages would give (100 + 50) / 2 = 75% → weak.
    // Raw sums give 11/21 ... so build a case where the two disagree:
    //   attempt A: 1/1 = 100%,  attempt B: 15/20 = 75%
    //   average of percentages = 87.5% (not weak)
    //   raw = 16/21 = 76.2%     (weak)  ← what the shared helper does
    const weak = calculateWeakTopics([
      attempt('2026-07-01T10:00:00.000Z', [['rxjs', 1, 1]]),
      attempt('2026-07-02T10:00:00.000Z', [['rxjs', 15, 20]])
    ]);
    expect(ids(weak)).toEqual(['rxjs']);
    expect(weak[0].percentage).toBeCloseTo((16 / 21) * 100, 5);
  });
});

describe('calculateWeakTopics — ranking', () => {
  it('ranks by LOWEST accuracy first', () => {
    const weak = calculateWeakTopics([
      attempt('2026-07-01T10:00:00.000Z', [
        ['mid', 5, 10], // 50%
        ['worst', 1, 10], // 10%
        ['near', 7, 10] // 70%
      ])
    ]);
    expect(ids(weak)).toEqual(['worst', 'mid', 'near']);
  });

  it('breaks an accuracy tie by HIGHEST incorrect count', () => {
    // Both 50%, but 'big' has 10 wrong vs 'small' 2.
    const weak = calculateWeakTopics([
      attempt('2026-07-01T10:00:00.000Z', [
        ['small', 2, 4],
        ['big', 10, 20]
      ])
    ]);
    expect(ids(weak)).toEqual(['big', 'small']);
  });

  it('breaks a remaining tie by MOST RECENT activity', () => {
    // Identical accuracy AND identical incorrect counts; recency decides.
    const weak = calculateWeakTopics([
      attempt('2026-07-01T10:00:00.000Z', [['older', 2, 4]]),
      attempt('2026-07-09T10:00:00.000Z', [['newer', 2, 4]])
    ]);
    expect(ids(weak)).toEqual(['newer', 'older']);
  });

  it('is fully deterministic when every ranking key ties', () => {
    const input = [
      attempt('2026-07-01T10:00:00.000Z', [
        ['bbb', 2, 4],
        ['aaa', 2, 4]
      ])
    ];
    const a = ids(calculateWeakTopics(input));
    expect(a).toEqual(['aaa', 'bbb']); // final tie-break: topicId
    expect(ids(calculateWeakTopics(input))).toEqual(a);
  });

  it('returns AT MOST three weak topics', () => {
    const weak = calculateWeakTopics([
      attempt('2026-07-01T10:00:00.000Z', [
        ['t1', 1, 10],
        ['t2', 2, 10],
        ['t3', 3, 10],
        ['t4', 4, 10],
        ['t5', 5, 10]
      ])
    ]);
    expect(weak).toHaveLength(WEAK_AREA_MAX_TOPICS);
    expect(ids(weak)).toEqual(['t1', 't2', 't3']); // the three weakest
  });
});

describe('calculateWeakTopics — resilience', () => {
  it('survives malformed, legacy and partial stored data', () => {
    const junk = [
      null,
      undefined,
      'not an attempt',
      42,
      {}, // no fields
      { completedAt: '2026-07-01T10:00:00.000Z' }, // no topicPerformance
      { topicPerformance: [] }, // no completedAt
      { completedAt: 5, topicPerformance: [] }, // wrong type
      { completedAt: '2026-07-01T10:00:00.000Z', topicPerformance: [{ topicId: '' }] },
      {
        completedAt: '2026-07-01T10:00:00.000Z',
        topicPerformance: [{ topicId: 'x', correct: 'a', total: 3 }]
      }
    ] as unknown as TopicAttemptLike[];

    expect(() => calculateWeakTopics(junk)).not.toThrow();
    expect(calculateWeakTopics(junk)).toEqual([]);
  });

  it('ignores bad entries but still uses the good ones alongside them', () => {
    const mixed = [
      null,
      attempt('2026-07-01T10:00:00.000Z', [['rxjs', 1, 10]]),
      { completedAt: 'x' }
    ] as unknown as TopicAttemptLike[];
    expect(ids(calculateWeakTopics(mixed))).toEqual(['rxjs']);
  });

  it('skips zero-total topic samples rather than treating them as 0%', () => {
    const weak = calculateWeakTopics([
      attempt('2026-07-01T10:00:00.000Z', [
        ['empty', 0, 0],
        ['real', 1, 10]
      ])
    ]);
    expect(ids(weak)).toEqual(['real']);
  });

  it('tolerates a non-array input', () => {
    expect(calculateWeakTopics(null as unknown as TopicAttemptLike[])).toEqual([]);
  });
});

describe('calculateWeakTopics — counted once', () => {
  it('counts each attempt exactly once (no double-count on repeated calls)', () => {
    const input = [attempt('2026-07-01T10:00:00.000Z', [['rxjs', 1, 10]])];
    const first = calculateWeakTopics(input);
    const second = calculateWeakTopics(input);
    expect(first[0]).toMatchObject({ correct: 1, total: 10 });
    expect(second).toEqual(first); // pure — no accumulation across calls
  });

  it('does not mutate the attempts it is given', () => {
    const input = [attempt('2026-07-01T10:00:00.000Z', [['rxjs', 1, 10]])];
    const snapshot = JSON.stringify(input);
    calculateWeakTopics(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
