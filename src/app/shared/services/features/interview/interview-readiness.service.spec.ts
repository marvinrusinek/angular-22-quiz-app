import { InterviewAttemptHistoryEntry, InterviewTopicHistoryEntry } from '@shared/models/interview-history.model';
import {
  aggregateTopicPercentages,
  buildExplanation,
  buildRecommendations,
  calculateConsistency,
  calculateRawConsistency,
  calculateReadiness,
  calculateRecentPerformance,
  calculateTopicCoverage,
  calculateTopicStrength,
  consistencyFromRange,
  getReadinessBand,
  READINESS_WEIGHTS,
  uniquePracticedTopics
} from './interview-readiness.service';

function topic(topicId: string, correct: number, total: number): InterviewTopicHistoryEntry {
  return { topicId, topicName: topicId.toUpperCase(), correct, total, percentage: Math.round((correct / total) * 100) };
}

function attempt(pct: number, topics: InterviewTopicHistoryEntry[] = [], i = 0): InterviewAttemptHistoryEntry {
  return {
    id: `a${i}-${pct}`,
    attemptNumber: i + 1,
    completedAt: `2026-07-${String(10 + i).padStart(2, '0')}T10:00:00.000Z`,
    score: pct,
    totalQuestions: 100,
    percentage: pct,
    completionReason: 'submitted',
    durationSeconds: 600,
    configuredDifficulty: 'mixed',
    selectedTopicIds: topics.map((t) => t.topicId),
    topicPerformance: topics
  };
}

// A list of attempts with the given percentages (topics optional).
function attempts(pcts: number[]): InterviewAttemptHistoryEntry[] {
  return pcts.map((p, i) => attempt(p, [topic('forms', p, 100)], i));
}

const EIGHT_TOPICS = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'];

describe('Recent Performance', () => {
  it('1. uses all attempts when fewer than five exist', () => {
    expect(calculateRecentPerformance(attempts([60, 80]))).toBe(70);
  });

  it('2. uses only the latest five when more than five exist', () => {
    // 8 attempts; latest five are 50,60,70,80,90 → 70.
    expect(calculateRecentPerformance(attempts([10, 20, 50, 60, 70, 80, 90]))).toBe(70);
  });

  it('3. calculates the correct average (rounded)', () => {
    expect(calculateRecentPerformance(attempts([70, 75]))).toBe(73);   // 72.5 → 73
  });

  it('4. handles empty history safely', () => {
    expect(calculateRecentPerformance([])).toBe(0);
  });
});

describe('Consistency', () => {
  it('5. gives a high score for a narrow range', () => {
    // range 4, avg ~92 → 100 * 0.92 ≈ 92
    expect(calculateConsistency(attempts([90, 94]))).toBe(92);
  });

  it('6. gives a lower score for a wide range', () => {
    // range 40 → stability 20; avg 70 → 20 * 0.7 = 14
    expect(calculateConsistency(attempts([50, 90]))).toBe(14);
  });

  it('7. applies the recent-performance safeguard (stable-low < stable-high)', () => {
    const stableLow = calculateConsistency(attempts([40, 42]));   // ~100 * 0.41
    const stableHigh = calculateConsistency(attempts([90, 92]));  // ~100 * 0.91
    expect(stableLow).toBeLessThan(stableHigh);
    expect(stableLow).toBe(41);
    expect(stableHigh).toBe(91);
  });

  it('8. never returns below 0 or above 100', () => {
    const c = calculateConsistency(attempts([100, 100, 100]));
    expect(c).toBeLessThanOrEqual(100);
    expect(c).toBeGreaterThanOrEqual(0);
    expect(consistencyFromRange(0)).toBe(100);
    expect(consistencyFromRange(99)).toBe(20);
  });
});

describe('Topic Coverage', () => {
  it('9/10. counts unique topics only (no duplicate appearances)', () => {
    const list = [
      attempt(80, [topic('a', 4, 5), topic('b', 3, 5)], 0),
      attempt(70, [topic('a', 2, 5), topic('c', 4, 5)], 1)   // 'a' repeats
    ];
    expect(uniquePracticedTopics(list).sort()).toEqual(['a', 'b', 'c']);
    expect(calculateTopicCoverage(list, 6)).toBe(50);        // 3 / 6 * 100
  });

  it('11. uses the eligible topic total dynamically', () => {
    const list = [attempt(80, [topic('a', 4, 5), topic('b', 3, 5)], 0)];
    expect(calculateTopicCoverage(list, 4)).toBe(50);
    expect(calculateTopicCoverage(list, 10)).toBe(20);
  });

  it('12. handles zero (or unknown) eligible topics safely → null', () => {
    expect(calculateTopicCoverage(attempts([80, 90]), 0)).toBeNull();
    expect(calculateTopicCoverage(attempts([80, 90]), NaN)).toBeNull();
  });
});

describe('Topic Strength', () => {
  it('13/14. aggregates raw correct/total across attempts (not rounded percentages)', () => {
    // Topic 'x': attempt1 1/3 (33%), attempt2 1/1 (100%). Rounded-average would be
    // (33+100)/2 = 66.5→67; raw is (1+1)/(3+1) = 50%.
    const list = [attempt(50, [topic('x', 1, 3)], 0), attempt(90, [topic('x', 1, 1)], 1)];
    expect(calculateTopicStrength(list)).toBe(50);
  });

  it('15. handles topics with different question totals', () => {
    // 'a': 8/10 = 80; 'b': 1/2 = 50 → average 65.
    const list = [attempt(80, [topic('a', 8, 10), topic('b', 1, 2)], 0)];
    expect(calculateTopicStrength(list)).toBe(65);
  });

  it('16. handles missing / zero-total topic data safely', () => {
    const list = [attempt(0, [], 0), attempt(0, [{ topicId: 'z', topicName: 'Z', correct: 0, total: 0, percentage: 0 }], 1)];
    expect(calculateTopicStrength(list)).toBe(0);
    expect(aggregateTopicPercentages(list)).toEqual([]);
  });
});

describe('Final Score', () => {
  it('17. applies the required weights correctly', () => {
    // Single-topic, coverage known. recent=avg(80,80)=80, consistency: range0→100*0.8=80,
    // topicStrength raw 80, coverage = 1/8*100 = 13 (round of 12.5).
    const list = attempts([80, 80]);
    const r = calculateReadiness(list, EIGHT_TOPICS)!;
    const expected = Math.round(80 * 0.45 + 80 * 0.2 + 13 * 0.2 + 80 * 0.15);
    expect(r.score).toBe(expected);
    expect(READINESS_WEIGHTS['recent-performance']).toBe(0.45);
  });

  it('18. rounds the result correctly', () => {
    const r = calculateReadiness(attempts([70, 75]), EIGHT_TOPICS)!;
    expect(Number.isInteger(r.score)).toBe(true);
  });

  it('19. clamps the result between 0 and 100', () => {
    const perfect = calculateReadiness(
      EIGHT_TOPICS.map((t, i) => attempt(100, [topic(t, 5, 5)], i)),
      EIGHT_TOPICS
    )!;
    expect(perfect.score).toBeLessThanOrEqual(100);
    const zero = calculateReadiness(attempts([0, 0]), EIGHT_TOPICS)!;
    expect(zero.score).toBeGreaterThanOrEqual(0);
  });

  it('20. returns the correct readiness band', () => {
    expect(getReadinessBand(0)).toBe('early-preparation');
    expect(getReadinessBand(39)).toBe('early-preparation');
    expect(getReadinessBand(40)).toBe('developing');
    expect(getReadinessBand(59)).toBe('developing');
    expect(getReadinessBand(60)).toBe('progressing');
    expect(getReadinessBand(74)).toBe('progressing');
    expect(getReadinessBand(75)).toBe('strong');
    expect(getReadinessBand(89)).toBe('strong');
    expect(getReadinessBand(90)).toBe('interview-ready');
    expect(getReadinessBand(100)).toBe('interview-ready');
  });

  it('renormalises weights when coverage is unavailable (empty eligible list)', () => {
    const r = calculateReadiness(attempts([80, 80]), [])!;
    expect(r.coverageAvailable).toBe(false);
    // (80*0.45 + 80*0.20 + 80*0.15) / 0.80 = 80
    expect(r.score).toBe(80);
  });
});

describe('Limited Data', () => {
  it('21. does not produce a full score for one attempt', () => {
    const r = calculateReadiness(attempts([80]), EIGHT_TOPICS)!;
    expect(r.status).toBe('insufficient');
    expect(r.score).toBe(0);
  });

  it('22. produces a score for two attempts', () => {
    const r = calculateReadiness(attempts([70, 80]), EIGHT_TOPICS)!;
    expect(r.status).toBe('ready');
    expect(r.score).toBeGreaterThan(0);
  });

  it('23. reports the correct number of attempts used (capped at 5)', () => {
    expect(calculateReadiness(attempts([70, 80, 90]), EIGHT_TOPICS)!.attemptsUsed).toBe(3);
    expect(calculateReadiness(attempts([10, 20, 30, 40, 50, 60, 70]), EIGHT_TOPICS)!.attemptsUsed).toBe(5);
  });

  it('returns null for no attempts (section hidden)', () => {
    expect(calculateReadiness([], EIGHT_TOPICS)).toBeNull();
  });
});

describe('Explanation & Recommendations', () => {
  it('24/25. identifies the strongest and limiting factors', () => {
    // High recent + strength, but tiny coverage (1 topic of 8).
    const r = calculateReadiness(attempts([95, 96]), EIGHT_TOPICS)!;
    expect(r.strongestFactor).toBe('recent-performance');
    expect(r.limitingFactor).toBe('topic-coverage');
    expect(r.explanation).toContain('strong');
    expect(r.explanation.toLowerCase()).toContain('topic coverage');
  });

  it('26. generates no more than two recommendations', () => {
    // Weak everything → many candidate recs, capped at 2.
    const weak = [
      attempt(30, [topic('a', 1, 5), topic('b', 1, 5)], 0),
      attempt(35, [topic('a', 1, 5), topic('c', 1, 5)], 1)
    ];
    const r = calculateReadiness(weak, EIGHT_TOPICS)!;
    expect(r.recommendations.length).toBeLessThanOrEqual(2);
    expect(r.recommendations.length).toBeGreaterThan(0);
  });

  it('prioritises weakest practiced topics first', () => {
    const list = [
      attempt(50, [topic('signals', 1, 10), topic('forms', 9, 10)], 0),
      attempt(55, [topic('signals', 1, 10), topic('forms', 9, 10)], 1)
    ];
    const recs = buildRecommendations(list, {
      topicCoverage: 80,
      coverageAvailable: true,
      recentPerformance: 52,
      rawConsistency: 90
    });
    expect(recs[0]).toContain('Review');
    expect(recs[0]).toContain('SIGNALS');   // weakest topic surfaced by name
  });

  it('appends an estimate caveat for the interview-ready band', () => {
    const r = calculateReadiness(
      EIGHT_TOPICS.map((t, i) => attempt(100, [topic(t, 5, 5)], i)),
      EIGHT_TOPICS
    )!;
    expect(r.band).toBe('interview-ready');
    expect(r.explanation.toLowerCase()).toContain('estimate');
  });

  // #4 — a mediocre highest factor must not be called "strong".
  it('does not call a mediocre highest factor "strong"', () => {
    // All factors < 75 (recent 48 is the highest).
    const r = calculateReadiness(attempts([46, 50]), EIGHT_TOPICS)!;
    expect(r.recentPerformance).toBeLessThan(75);
    expect(r.strongestFactor).toBe('recent-performance');
    expect(r.explanation).toContain('highest readiness factor');
    expect(r.explanation).not.toContain('scores are strong');
  });

  it('still praises a genuinely strong highest factor (≥ 75)', () => {
    expect(buildExplanation(
      { key: 'recent-performance', value: 88 },
      { key: 'topic-coverage', value: 30 },
      100,
      'strong'
    )).toContain('Your recent interview scores are strong.');
  });

  // #5 — consistency wording uses RAW stability, not the safeguarded factor.
  it('does not tell a stable-but-low user their scores "vary"', () => {
    const stable = buildExplanation(
      { key: 'recent-performance', value: 70 },
      { key: 'consistency', value: 45 },   // low adjusted factor…
      100,                                 // …but perfectly stable (raw 100)
      'progressing'
    );
    expect(stable).toContain('steady');
    expect(stable.toLowerCase()).not.toContain('vary');
  });

  it('does say scores "vary" when they genuinely do', () => {
    const varying = buildExplanation(
      { key: 'recent-performance', value: 70 },
      { key: 'consistency', value: 40 },
      40,   // raw stability low → scores actually vary
      'progressing'
    );
    expect(varying.toLowerCase()).toContain('vary');
  });

  it('does not recommend consistency work for a stable (low) user', () => {
    const stable = buildRecommendations(attempts([45, 45, 45]), {
      topicCoverage: 80,
      coverageAvailable: true,
      recentPerformance: 45,
      rawConsistency: 100
    });
    expect(stable.some((r) => r.toLowerCase().includes('consistent'))).toBe(false);
    // Strong topics + high recent + broad coverage → the only rec left to fire is
    // the genuine-variance one.
    const varying = buildRecommendations(
      [attempt(70, [topic('forms', 8, 10)], 0), attempt(70, [topic('forms', 8, 10)], 1)],
      { topicCoverage: 90, coverageAvailable: true, recentPerformance: 78, rawConsistency: 20 }
    );
    expect(varying.some((r) => r.toLowerCase().includes('consistent'))).toBe(true);
  });

  it('rawConsistency reflects range only (not performance)', () => {
    expect(calculateRawConsistency(attempts([45, 45, 45]))).toBe(100);   // stable
    expect(calculateRawConsistency(attempts([30, 70]))).toBe(20);        // wide range
    expect(calculateRawConsistency(attempts([80]))).toBe(0);             // < 2 attempts
  });
});
