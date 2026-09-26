import { AttemptTally } from '@shared/models';
import { aggregateTopicPercentages } from './interview-topic-history';
import {
  accuracyPercent,
  buildPerformanceInsights,
  compareWindows,
  COMPARISON_MAX_WINDOW,
  COMPARISON_MIN_WINDOW,
  groupIntoLogicalAttempts,
  selectStrongestTopics,
  STRONGEST_MAX_TOPICS,
  summarizeSource,
  summarizeTopics,
  tallyInterviewAttempts,
  TopicRecordLike
} from './performance-insights';
import { calculateWeakTopics, TopicAttemptLike, WEAK_AREA_MIN_ANSWERED } from './weak-areas';

// ── factories ───────────────────────────────────────────────────────

const day = (n: number): string => new Date(Date.UTC(2026, 6, n, 10, 0, 0)).toISOString();

const rec = (
  attemptId: string,
  source: TopicRecordLike['source'],
  completedAt: string,
  correct: number,
  total: number
): TopicRecordLike => ({ attemptId, source, completedAt, correct, total });

type TopicSpec = [topicId: string, correct: number, total: number];

const att = (completedAt: string, topics: TopicSpec[]): TopicAttemptLike => ({
  completedAt,
  topicPerformance: topics.map(([topicId, correct, total]) => ({
    topicId,
    topicName: topicId.toUpperCase(),
    correct,
    total,
    percentage: total > 0 ? (correct / total) * 100 : 0
  }))
});

const tally = (id: string, n: number, correct: number, total: number): AttemptTally => ({
  id,
  completedAt: day(n),
  correct,
  total
});

/** n attempts, oldest first, each `correct/total`. */
const run = (n: number, correct: number, total: number, from = 1): AttemptTally[] =>
  Array.from({ length: n }, (_, i) => tally(`t${from + i}`, from + i, correct, total));

const ids = (xs: readonly { topicId: string }[]): string[] => xs.map((x) => x.topicId);

// ── accuracy ────────────────────────────────────────────────────────

describe('accuracyPercent', () => {
  it('is question-weighted whole-percent, rounded', () => {
    expect(accuracyPercent(1, 3)).toBe(33);
    expect(accuracyPercent(2, 3)).toBe(67);
    expect(accuracyPercent(22, 24)).toBe(92);
    expect(accuracyPercent(0, 5)).toBe(0);
    expect(accuracyPercent(5, 5)).toBe(100);
  });

  it('never returns NaN or Infinity for a zero or invalid denominator', () => {
    for (const [c, t] of [[0, 0], [5, 0], [1, -3], [NaN, 4], [3, NaN], [Infinity, 4], [3, Infinity]] as const) {
      const pct = accuracyPercent(c, t);
      expect(Number.isFinite(pct)).toBe(true);
      expect(pct).toBe(0);
    }
  });

  it('clamps correct above total and below zero into 0–100', () => {
    expect(accuracyPercent(99, 10)).toBe(100);
    expect(accuracyPercent(-4, 10)).toBe(0);
  });
});

// ── logical attempts ────────────────────────────────────────────────

describe('groupIntoLogicalAttempts', () => {
  it('counts a multi-topic attempt ONCE and sums its rows', () => {
    const rows = [
      rec('p1', 'weak-areas-practice', day(1), 1, 4),
      rec('p1', 'weak-areas-practice', day(1), 3, 6),
      rec('p1', 'weak-areas-practice', day(1), 2, 2)
    ];
    expect(groupIntoLogicalAttempts(rows, 'weak-areas-practice')).toEqual([
      { id: 'p1', completedAt: day(1), correct: 6, total: 12 }
    ]);
  });

  it('separates attempts by attemptId', () => {
    const rows = [
      rec('a', 'topic-quiz', day(1), 1, 2),
      rec('b', 'topic-quiz', day(2), 2, 2)
    ];
    expect(groupIntoLogicalAttempts(rows, 'topic-quiz').map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('only returns the requested source', () => {
    const rows = [
      rec('q1', 'topic-quiz', day(1), 1, 2),
      rec('p1', 'weak-areas-practice', day(2), 2, 2)
    ];
    expect(groupIntoLogicalAttempts(rows, 'topic-quiz').map((t) => t.id)).toEqual(['q1']);
    expect(groupIntoLogicalAttempts(rows, 'weak-areas-practice').map((t) => t.id)).toEqual(['p1']);
  });

  it('sorts chronologically whatever order the rows arrive in', () => {
    const rows = [
      rec('c', 'topic-quiz', day(9), 1, 2),
      rec('a', 'topic-quiz', day(1), 1, 2),
      rec('b', 'topic-quiz', day(5), 1, 2)
    ];
    expect(groupIntoLogicalAttempts(rows, 'topic-quiz').map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('breaks an identical-timestamp tie by id, deterministically', () => {
    const rows = [rec('zz', 'topic-quiz', day(1), 1, 2), rec('aa', 'topic-quiz', day(1), 1, 2)];
    expect(groupIntoLogicalAttempts(rows, 'topic-quiz').map((t) => t.id)).toEqual(['aa', 'zz']);
  });

  it('keeps a partially-retained attempt as ONE smaller attempt', () => {
    // The 200-row cap can cut the oldest attempt. Its surviving rows still group.
    const rows = [rec('cut', 'weak-areas-practice', day(1), 1, 2)];
    expect(groupIntoLogicalAttempts(rows, 'weak-areas-practice')).toEqual([
      { id: 'cut', completedAt: day(1), correct: 1, total: 2 }
    ]);
  });

  it('skips malformed and empty-sample rows instead of throwing', () => {
    const junk = [
      null,
      undefined,
      {},
      rec('', 'topic-quiz', day(1), 1, 2),
      rec('no-date', 'topic-quiz', 'nope', 1, 2),
      rec('zero', 'topic-quiz', day(1), 0, 0),
      rec('nan', 'topic-quiz', day(1), NaN, 4),
      rec('good', 'topic-quiz', day(2), 1, 2)
    ] as unknown as TopicRecordLike[];
    expect(() => groupIntoLogicalAttempts(junk, 'topic-quiz')).not.toThrow();
    expect(groupIntoLogicalAttempts(junk, 'topic-quiz').map((t) => t.id)).toEqual(['good']);
    expect(groupIntoLogicalAttempts(null as unknown as TopicRecordLike[], 'topic-quiz')).toEqual([]);
  });

  it('returns nothing for no history', () => {
    expect(groupIntoLogicalAttempts([], 'topic-quiz')).toEqual([]);
  });
});

describe('tallyInterviewAttempts', () => {
  it('uses the attempt-level score and total, one tally per history entry', () => {
    const out = tallyInterviewAttempts([
      { id: 'i2', completedAt: day(5), score: 9, totalQuestions: 10 },
      { id: 'i1', completedAt: day(1), score: 4, totalQuestions: 10 }
    ]);
    expect(out).toEqual([
      { id: 'i1', completedAt: day(1), correct: 4, total: 10 },
      { id: 'i2', completedAt: day(5), correct: 9, total: 10 }
    ]);
  });

  it('skips entries with no usable sample', () => {
    const out = tallyInterviewAttempts([
      { id: 'bad', completedAt: day(1), score: 0, totalQuestions: 0 },
      null as never
    ]);
    expect(out).toEqual([]);
  });
});

// ── source summary ──────────────────────────────────────────────────

describe('summarizeSource', () => {
  it('is null — never zeros — when a source has no history', () => {
    expect(summarizeSource('topic-quiz', [])).toBeNull();
    expect(summarizeSource('interview', [])).toBeNull();
    expect(summarizeSource('weak-areas-practice', [])).toBeNull();
  });

  it('reports one attempt with its sample size and NO comparison', () => {
    const s = summarizeSource('topic-quiz', [tally('a', 3, 7, 10)])!;
    expect(s).toMatchObject({
      source: 'topic-quiz', attempts: 1, correct: 7, total: 10, accuracyPct: 70, latestAt: day(3), comparison: null
    });
  });

  it('is QUESTION-WEIGHTED: sum(correct)/sum(total), not the mean of percentages', () => {
    // 1/1 = 100% and 15/20 = 75%. Mean of percentages = 87.5. Raw = 16/21 = 76.19.
    const s = summarizeSource('topic-quiz', [tally('a', 1, 1, 1), tally('b', 2, 15, 20)])!;
    expect(s.correct).toBe(16);
    expect(s.total).toBe(21);
    expect(s.accuracyPct).toBe(76);
    expect(s.accuracyPct).not.toBe(88);
  });

  it('reports the newest attempt as latestAt and counts every attempt', () => {
    const s = summarizeSource('interview', [tally('b', 9, 5, 10), tally('a', 2, 5, 10), tally('c', 4, 5, 10)])!;
    expect(s.attempts).toBe(3);
    expect(s.latestAt).toBe(day(9));
  });

  it('is unaffected by the order tallies arrive in', () => {
    const forward = run(8, 6, 10);
    const shuffled = [forward[5], forward[1], forward[7], forward[0], forward[3], forward[6], forward[2], forward[4]] as AttemptTally[];
    expect(summarizeSource('topic-quiz', shuffled)).toEqual(summarizeSource('topic-quiz', forward));
  });

  it('discloses the retention window per source, never "lifetime"', () => {
    expect(summarizeSource('interview', [tally('a', 1, 1, 2)])!.retentionLabel).toBe('20 most recent interviews');
    expect(summarizeSource('topic-quiz', [tally('a', 1, 1, 2)])!.retentionLabel).toBe('200 most recent topic results');
    expect(summarizeSource('weak-areas-practice', [tally('a', 1, 1, 2)])!.retentionLabel).toBe('200 most recent topic results');
    for (const source of ['interview', 'topic-quiz', 'weak-areas-practice'] as const) {
      expect(summarizeSource(source, [tally('a', 1, 1, 2)])!.retentionLabel).not.toMatch(/lifetime|all.?time/i);
    }
  });

  it('skips an attempt with a zero denominator rather than diluting the total', () => {
    const s = summarizeSource('topic-quiz', [tally('a', 1, 5, 10), tally('zero', 2, 0, 0)])!;
    expect(s.attempts).toBe(1);
    expect(s.total).toBe(10);
  });
});

// ── recent vs previous ──────────────────────────────────────────────

describe('compareWindows — minimum-data rule', () => {
  it('constants: at most 5 per window, at least 2', () => {
    expect(COMPARISON_MAX_WINDOW).toBe(5);
    expect(COMPARISON_MIN_WINDOW).toBe(2);
  });

  it.each([0, 1, 2, 3])('is unavailable with %i attempt(s) — nothing is fabricated', (n) => {
    expect(compareWindows(run(n, 6, 10))).toBeNull();
  });

  it('becomes available at 4 attempts: latest 2 vs the 2 before', () => {
    const c = compareWindows(run(4, 6, 10))!;
    expect(c).not.toBeNull();
    expect(c.recent.attempts).toBe(2);
    expect(c.previous.attempts).toBe(2);
  });

  it.each([
    [4, 2], [5, 2], [6, 3], [7, 3], [8, 4], [9, 4], [10, 5], [11, 5], [25, 5]
  ])('with %i attempts each window holds %i (equal-sized, capped at 5)', (n, size) => {
    const c = compareWindows(run(n, 6, 10))!;
    expect(c.recent.attempts).toBe(size);
    expect(c.previous.attempts).toBe(size);
  });

  it('from 10 attempts it is exactly the latest 5 vs the 5 before', () => {
    // t1-t5 previous (all 2/10), t6-t10 recent (all 9/10)
    const all = [...run(5, 2, 10, 1), ...run(5, 9, 10, 6)];
    const c = compareWindows(all)!;
    expect(c.previous).toMatchObject({ attempts: 5, correct: 10, total: 50, accuracyPct: 20 });
    expect(c.recent).toMatchObject({ attempts: 5, correct: 45, total: 50, accuracyPct: 90 });
    expect(c.deltaPts).toBe(70);
  });

  it('ignores attempts older than the two windows', () => {
    // 12 attempts: t1-t2 are older than both windows and must not matter.
    const older = run(2, 0, 10, 1);
    const previous = run(5, 5, 10, 3);
    const recent = run(5, 8, 10, 8);
    const c = compareWindows([...older, ...previous, ...recent])!;
    expect(c.previous.accuracyPct).toBe(50);
    expect(c.recent.accuracyPct).toBe(80);
  });

  it('odd counts drop the OLDEST attempt, never the newest', () => {
    // 5 attempts → w=2 → recent = t4,t5 ; previous = t2,t3 ; t1 ignored.
    const c = compareWindows([
      tally('t1', 1, 0, 10), tally('t2', 2, 5, 10), tally('t3', 3, 5, 10), tally('t4', 4, 9, 10), tally('t5', 5, 9, 10)
    ])!;
    expect(c.previous.accuracyPct).toBe(50);
    expect(c.recent.accuracyPct).toBe(90);
  });
});

describe('compareWindows — arithmetic', () => {
  it('reports plain percentages and a signed point delta', () => {
    // previous 78%, recent 84%  →  +6
    const c = compareWindows([
      ...run(2, 78, 100, 1),
      ...run(2, 84, 100, 3)
    ])!;
    expect(c.previous.accuracyPct).toBe(78);
    expect(c.recent.accuracyPct).toBe(84);
    expect(c.deltaPts).toBe(6);
  });

  it('is negative when the recent window is lower', () => {
    const c = compareWindows([...run(2, 9, 10, 1), ...run(2, 6, 10, 3)])!;
    expect(c.deltaPts).toBe(-30);
  });

  it('a genuine no-change comparison is a real 0, not "unavailable"', () => {
    const c = compareWindows(run(4, 7, 10))!;
    expect(c).not.toBeNull();
    expect(c.deltaPts).toBe(0);
  });

  it('computes the delta from the DISPLAYED percentages so the numbers add up', () => {
    // recent 422/500 = 84.4% → 84 ; previous 388/500 = 77.6% → 78.
    // An unrounded delta (6.8 → 7) would contradict the 84 and 78 on screen.
    const c = compareWindows([
      tally('p1', 1, 194, 250), tally('p2', 2, 194, 250),
      tally('r1', 3, 211, 250), tally('r2', 4, 211, 250)
    ])!;
    expect(c.previous.accuracyPct).toBe(78);
    expect(c.recent.accuracyPct).toBe(84);
    expect(c.deltaPts).toBe(c.recent.accuracyPct - c.previous.accuracyPct);
    expect(c.deltaPts).toBe(6);
  });

  it('weights each window by QUESTIONS, not by attempts', () => {
    // recent: 1/1 (100%) and 1/9 (11%) → 2/10 = 20%, not the 56% mean.
    const c = compareWindows([
      tally('p1', 1, 5, 10), tally('p2', 2, 5, 10),
      tally('r1', 3, 1, 1), tally('r2', 4, 1, 9)
    ])!;
    expect(c.recent).toMatchObject({ correct: 2, total: 10, accuracyPct: 20 });
  });
});

describe('compareWindows — minimum sample', () => {
  it('is unavailable when a window has fewer than the minimum answered questions', () => {
    // 4 attempts of 1 question each → each window holds 2 < 3.
    expect(WEAK_AREA_MIN_ANSWERED).toBe(3);
    expect(compareWindows(run(4, 1, 1))).toBeNull();
  });

  it('is available once BOTH windows reach the minimum', () => {
    const c = compareWindows([
      tally('p1', 1, 1, 1), tally('p2', 2, 1, 2),   // previous: 3 questions
      tally('r1', 3, 1, 2), tally('r2', 4, 1, 1)    // recent:   3 questions
    ]);
    expect(c).not.toBeNull();
  });

  it('is unavailable when only ONE window is too small', () => {
    const c = compareWindows([
      tally('p1', 1, 1, 1), tally('p2', 2, 1, 1),   // previous: 2 questions
      tally('r1', 3, 5, 10), tally('r2', 4, 5, 10)
    ]);
    expect(c).toBeNull();
  });
});

describe('summarizeSource — comparison wiring', () => {
  it('attaches a comparison only when the rule allows it', () => {
    expect(summarizeSource('topic-quiz', run(3, 6, 10))!.comparison).toBeNull();
    expect(summarizeSource('topic-quiz', run(4, 6, 10))!.comparison).not.toBeNull();
  });

  it('never labels the change — it exposes numbers only', () => {
    const c = summarizeSource('topic-quiz', run(6, 6, 10))!.comparison!;
    expect(Object.keys(c).sort()).toEqual(['deltaPts', 'previous', 'recent']);
    expect(JSON.stringify(c)).not.toMatch(/improv|declin|good|bad|better|worse/i);
  });
});

// ── topics ──────────────────────────────────────────────────────────

describe('summarizeTopics', () => {
  it('is empty for no history', () => {
    expect(summarizeTopics([])).toEqual([]);
  });

  it('agrees exactly with the shared aggregation — same counts, no second algorithm', () => {
    const attempts = [
      att(day(1), [['rxjs', 3, 5], ['forms', 8, 10]]),
      att(day(2), [['rxjs', 4, 4], ['signals', 1, 6]]),
      att(day(3), [['forms', 1, 2]])
    ];
    const shared = aggregateTopicPercentages(attempts as never);
    const mine = summarizeTopics(attempts);

    expect(mine).toHaveLength(shared.length);
    for (const s of shared) {
      const m = mine.find((t) => t.topicId === s.topicId)!;
      expect(m).toMatchObject({ topicId: s.topicId, topicName: s.topicName, correct: s.correct, total: s.total });
      expect(m.percentage).toBe(Math.round(s.percentage));
    }
  });

  it('carries name, correct, total, whole percentage and last activity', () => {
    const [t] = summarizeTopics([
      att(day(1), [['signals', 20, 24]]),
      att(day(4), [['signals', 2, 2]])
    ]);
    expect(t).toEqual({
      topicId: 'signals', topicName: 'SIGNALS', correct: 22, total: 26,
      percentage: 85, lastActivityAt: day(4), hasEnoughData: true
    });
  });

  it('keeps under-sampled topics visible but flagged, so a percentage is never bare', () => {
    const [t] = summarizeTopics([att(day(1), [['http', 2, 2]])]);
    expect(t).toMatchObject({ correct: 2, total: 2, percentage: 100, hasEnoughData: false });
  });

  it('orders by most evidence first, then topicId', () => {
    const out = summarizeTopics([att(day(1), [['b', 1, 4], ['a', 1, 4], ['big', 5, 20]])]);
    expect(ids(out)).toEqual(['big', 'a', 'b']);
  });

  it('skips zero-total samples and never yields NaN', () => {
    const out = summarizeTopics([att(day(1), [['empty', 0, 0], ['real', 1, 4]])]);
    expect(ids(out)).toEqual(['real']);
    expect(out.every((t) => Number.isFinite(t.percentage))).toBe(true);
  });

  it('survives malformed attempts', () => {
    const junk = [null, {}, { completedAt: 5 }, att(day(1), [['rxjs', 1, 4]])] as unknown as TopicAttemptLike[];
    expect(() => summarizeTopics(junk)).not.toThrow();
    expect(ids(summarizeTopics(junk))).toEqual(['rxjs']);
  });
});

// ── strongest ───────────────────────────────────────────────────────

describe('selectStrongestTopics', () => {
  it('is empty for no history', () => {
    expect(selectStrongestTopics([], [])).toEqual([]);
  });

  it('excludes a topic below the minimum sample, however perfect', () => {
    const attempts = [att(day(1), [['tiny', 2, 2], ['solid', 9, 10]])];
    expect(ids(selectStrongestTopics(attempts, []))).toEqual(['solid']);
  });

  it('includes a topic at exactly the minimum sample', () => {
    expect(ids(selectStrongestTopics([att(day(1), [['edge', 3, 3]])], []))).toEqual(['edge']);
  });

  it('excludes every topic Weak Areas would call weak', () => {
    const attempts = [att(day(1), [['weak', 5, 10], ['strong', 9, 10]])];
    const needsReview = calculateWeakTopics(attempts);
    expect(ids(needsReview)).toEqual(['weak']);
    expect(ids(selectStrongestTopics(attempts, needsReview))).toEqual(['strong']);
  });

  it('treats exactly 80% as NOT weak, so it is eligible', () => {
    const attempts = [att(day(1), [['boundary', 8, 10]])];
    expect(calculateWeakTopics(attempts)).toEqual([]);
    expect(ids(selectStrongestTopics(attempts, []))).toEqual(['boundary']);
  });

  it('never promotes a weak topic that Needs Review omitted only because of its 3-topic cap', () => {
    // Five weak topics; Needs Review shows just the weakest three. The other two
    // are STILL weak and must not become "strongest".
    const attempts = [att(day(1), [
      ['w1', 1, 10], ['w2', 2, 10], ['w3', 3, 10], ['w4', 4, 10], ['w5', 5, 10], ['ok', 9, 10]
    ])];
    const needsReview = calculateWeakTopics(attempts);
    expect(ids(needsReview)).toEqual(['w1', 'w2', 'w3']);
    expect(ids(selectStrongestTopics(attempts, needsReview))).toEqual(['ok']);
  });

  it('also honours a caller-supplied Needs Review list', () => {
    const attempts = [att(day(1), [['a', 9, 10], ['b', 9, 10]])];
    const forced = calculateWeakTopics([att(day(1), [['a', 0, 10]])]);   // says "a" is weak
    expect(ids(selectStrongestTopics(attempts, forced))).toEqual(['b']);
  });

  it('ranks by accuracy, best first', () => {
    const attempts = [att(day(1), [['c', 8, 10], ['a', 10, 10], ['b', 9, 10]])];
    expect(ids(selectStrongestTopics(attempts, []))).toEqual(['a', 'b', 'c']);
  });

  it('breaks an accuracy tie by the LARGER sample', () => {
    const attempts = [att(day(1), [['small', 9, 10], ['large', 18, 20]])];
    expect(ids(selectStrongestTopics(attempts, []))).toEqual(['large', 'small']);
  });

  it('breaks a remaining tie by most recent activity, then topicId', () => {
    const recency = [att(day(1), [['older', 9, 10]]), att(day(9), [['newer', 9, 10]])];
    expect(ids(selectStrongestTopics(recency, []))).toEqual(['newer', 'older']);

    const same = [att(day(1), [['bbb', 9, 10], ['aaa', 9, 10]])];
    expect(ids(selectStrongestTopics(same, []))).toEqual(['aaa', 'bbb']);
  });

  it('is deterministic across repeated calls', () => {
    const attempts = [att(day(1), [['x', 9, 10], ['y', 9, 10], ['z', 9, 10]])];
    expect(selectStrongestTopics(attempts, [])).toEqual(selectStrongestTopics(attempts, []));
  });

  it('lists at most three', () => {
    const attempts = [att(day(1), [['a', 10, 10], ['b', 10, 10], ['c', 10, 10], ['d', 10, 10], ['e', 10, 10]])];
    expect(STRONGEST_MAX_TOPICS).toBe(3);
    expect(selectStrongestTopics(attempts, [])).toHaveLength(3);
  });

  it('does not mutate its inputs', () => {
    const attempts = [att(day(1), [['a', 9, 10], ['b', 2, 10]])];
    const needsReview = calculateWeakTopics(attempts);
    const snapshot = JSON.stringify({ attempts, needsReview });
    selectStrongestTopics(attempts, needsReview);
    expect(JSON.stringify({ attempts, needsReview })).toBe(snapshot);
  });

  describe('INVARIANT: Strongest ∩ Needs Review = ∅', () => {
    // A small deterministic generator, so a failure reproduces exactly.
    const lcg = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;

    it('holds across many generated histories, using the real Weak Areas calculation', () => {
      const rnd = lcg(20260921);
      const topicIds = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'];

      for (let trial = 0; trial < 300; trial++) {
        const attempts: TopicAttemptLike[] = [];
        for (let a = 0, n = 1 + Math.floor(rnd() * 8); a < n; a++) {
          const topics: TopicSpec[] = topicIds
            .filter(() => rnd() < 0.6)
            .map((id) => {
              const total = Math.floor(rnd() * 12);
              return [id, Math.floor(rnd() * (total + 1)), total] as TopicSpec;
            });
          attempts.push(att(day(1 + a), topics));
        }

        const needsReview = calculateWeakTopics(attempts);
        const strongest = selectStrongestTopics(attempts, needsReview);

        const weakIds = new Set(calculateWeakTopics(attempts, { max: Infinity }).map((t) => t.topicId));
        for (const s of strongest) {
          expect(needsReview.map((t) => t.topicId)).not.toContain(s.topicId);
          expect(weakIds.has(s.topicId)).toBe(false);
          expect(s.total).toBeGreaterThanOrEqual(WEAK_AREA_MIN_ANSWERED);
        }
      }
    });
  });
});

// ── assembly ────────────────────────────────────────────────────────

describe('buildPerformanceInsights', () => {
  const empty = { topicRecords: [], interviewAttempts: [], attempts: [], needsReview: [] };

  it('reports no data at all for empty history', () => {
    expect(buildPerformanceInsights(empty)).toEqual({
      hasData: false, topicQuiz: null, interview: null, practice: null, topics: [], strongest: [], needsReview: []
    });
  });

  it('with ONLY Topic Quiz history: no fake Interview or Practice zeros', () => {
    const records = [rec('q1', 'topic-quiz', day(1), 3, 4)];
    const out = buildPerformanceInsights({ ...empty, topicRecords: records });
    expect(out.hasData).toBe(true);
    expect(out.topicQuiz).toMatchObject({ attempts: 1, correct: 3, total: 4 });
    expect(out.interview).toBeNull();
    expect(out.practice).toBeNull();
  });

  it('with ONLY Interview history: no fake Topic Quiz or Practice zeros', () => {
    const out = buildPerformanceInsights({
      ...empty,
      interviewAttempts: [{ id: 'i1', completedAt: day(1), score: 7, totalQuestions: 10 }]
    });
    expect(out.interview).toMatchObject({ attempts: 1, correct: 7, total: 10, accuracyPct: 70 });
    expect(out.topicQuiz).toBeNull();
    expect(out.practice).toBeNull();
  });

  it('with ONLY Practice history: it stays labelled Practice, never Topic Quiz', () => {
    const out = buildPerformanceInsights({
      ...empty,
      topicRecords: [rec('p1', 'weak-areas-practice', day(1), 2, 4)]
    });
    expect(out.practice).toMatchObject({ source: 'weak-areas-practice', attempts: 1, correct: 2, total: 4 });
    expect(out.topicQuiz).toBeNull();
    expect(out.interview).toBeNull();
  });

  it('keeps all three sources SEPARATE and offers no combined figure', () => {
    const out = buildPerformanceInsights({
      ...empty,
      topicRecords: [
        rec('q1', 'topic-quiz', day(1), 10, 10),
        rec('p1', 'weak-areas-practice', day(2), 1, 10)
      ],
      interviewAttempts: [{ id: 'i1', completedAt: day(3), score: 5, totalQuestions: 10 }]
    });

    expect(out.topicQuiz!.accuracyPct).toBe(100);
    expect(out.practice!.accuracyPct).toBe(10);
    expect(out.interview!.accuracyPct).toBe(50);
    // 16/30 = 53% would be the meaningless blend. It must not exist anywhere.
    expect(JSON.stringify(out)).not.toContain('"accuracyPct":53');
    expect(Object.keys(out).sort()).toEqual(
      ['hasData', 'interview', 'needsReview', 'practice', 'strongest', 'topicQuiz', 'topics']
    );
    for (const banned of ['overall', 'combined', 'total', 'accuracyPct', 'skill', 'score']) {
      expect(Object.keys(out)).not.toContain(banned);
    }
  });

  it('shows a multi-topic practice attempt as ONE attempt', () => {
    const out = buildPerformanceInsights({
      ...empty,
      topicRecords: [
        rec('p1', 'weak-areas-practice', day(1), 1, 2),
        rec('p1', 'weak-areas-practice', day(1), 1, 2),
        rec('p1', 'weak-areas-practice', day(1), 1, 2),
        rec('p1', 'weak-areas-practice', day(1), 1, 2),
        rec('p1', 'weak-areas-practice', day(1), 1, 2)
      ]
    });
    expect(out.practice!.attempts).toBe(1);
    expect(out.practice!.comparison).toBeNull();
  });

  it('passes Needs Review through untouched', () => {
    const attempts = [att(day(1), [['rxjs', 1, 10], ['forms', 9, 10]])];
    const needsReview = calculateWeakTopics(attempts);
    const out = buildPerformanceInsights({ ...empty, attempts, needsReview });
    expect(out.needsReview).toEqual(needsReview);
    expect(ids(out.strongest)).toEqual(['forms']);
    expect(ids(out.needsReview)).toEqual(['rxjs']);
  });

  it('computes topics from the merged dataset it is given', () => {
    const out = buildPerformanceInsights({
      ...empty,
      attempts: [att(day(1), [['rxjs', 3, 5]]), att(day(2), [['rxjs', 2, 5]])]
    });
    expect(out.topics).toHaveLength(1);
    expect(out.topics[0]).toMatchObject({ topicId: 'rxjs', correct: 5, total: 10, percentage: 50 });
    expect(out.hasData).toBe(true);
  });

  it('gives each source its own recent-vs-previous comparison', () => {
    const records = Array.from({ length: 4 }, (_, i) =>
      rec(`q${i}`, 'topic-quiz', day(i + 1), i < 2 ? 5 : 9, 10)
    );
    const out = buildPerformanceInsights({ ...empty, topicRecords: records });
    expect(out.topicQuiz!.comparison).toMatchObject({ deltaPts: 40 });
    expect(out.interview).toBeNull();
  });

  it('does not mutate its input', () => {
    const input = {
      topicRecords: [rec('q1', 'topic-quiz', day(1), 1, 2)],
      interviewAttempts: [{ id: 'i1', completedAt: day(2), score: 1, totalQuestions: 2 }],
      attempts: [att(day(1), [['rxjs', 1, 4]])],
      needsReview: calculateWeakTopics([att(day(1), [['rxjs', 1, 4]])])
    };
    const snapshot = JSON.stringify(input);
    buildPerformanceInsights(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('is deterministic', () => {
    const input = {
      topicRecords: [rec('q1', 'topic-quiz', day(1), 1, 2), rec('q2', 'topic-quiz', day(2), 2, 2)],
      interviewAttempts: [{ id: 'i1', completedAt: day(2), score: 1, totalQuestions: 2 }],
      attempts: [att(day(1), [['rxjs', 1, 4], ['forms', 4, 4]])],
      needsReview: []
    };
    expect(buildPerformanceInsights(input)).toEqual(buildPerformanceInsights(input));
  });

  it('tolerates non-array inputs', () => {
    const out = buildPerformanceInsights({
      topicRecords: null as never,
      interviewAttempts: undefined as never,
      attempts: null as never,
      needsReview: null as never
    });
    expect(out.hasData).toBe(false);
    expect(out.needsReview).toEqual([]);
  });
});
