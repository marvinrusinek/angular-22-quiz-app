import { Quiz, TopicPerformanceRecord } from '@shared/models';
import { selectReviewCandidate } from './review-candidate';

const quiz = (quizId: string, milestone: string, difficulty = 'beginner'): Quiz =>
  ({ quizId, milestone, difficulty }) as Quiz;

const rec = (
  topicId: string,
  correct: number,
  total: number,
  completedAt: string,
  source: TopicPerformanceRecord['source'] = 'topic-quiz'
): TopicPerformanceRecord => ({
  attemptId: `${source}:${topicId}:${completedAt}`,
  source,
  completedAt,
  topicId,
  topicName: topicId,
  correct,
  total
});

const CATALOG = [
  quiz('forms', 'Forms', 'intermediate'),
  quiz('pipes', 'Pipes'),
  quiz('http', 'HTTP', 'advanced')
];
const ALL = new Set(['forms', 'pipes', 'http']);
const D1 = '2026-10-01T10:00:00.000Z';
const D2 = '2026-10-02T10:00:00.000Z';
const D3 = '2026-10-03T10:00:00.000Z';

describe('selectReviewCandidate', () => {
  it('picks the completed quiz with the lowest latest score', () => {
    const r = selectReviewCandidate(CATALOG, ALL, [
      rec('forms', 9, 10, D1),
      rec('pipes', 4, 10, D1),
      rec('http', 7, 10, D1)
    ]);
    expect(r).toEqual({
      quizId: 'pipes',
      title: 'Pipes',
      difficulty: 'beginner',
      latestPercent: 40,
      completedAt: D1
    });
  });

  it('uses the LATEST attempt, not the best or the worst', () => {
    const r = selectReviewCandidate(CATALOG, ALL, [
      rec('pipes', 2, 10, D1), // old, bad
      rec('pipes', 10, 10, D3), // latest, perfect
      rec('forms', 6, 10, D2),
      rec('http', 8, 10, D1)
    ]);
    expect(r?.quizId).toBe('forms'); // pipes' latest is 100%
    expect(r?.latestPercent).toBe(60);
  });

  it('a worse retake replaces an earlier better attempt', () => {
    const r = selectReviewCandidate(CATALOG, ALL, [
      rec('pipes', 10, 10, D1),
      rec('forms', 6, 10, D1),
      rec('http', 8, 10, D1),
      rec('pipes', 3, 10, D2) // retake, worse
    ]);
    expect(r?.quizId).toBe('pipes');
    expect(r?.latestPercent).toBe(30);
  });

  it('does not depend on the order of the records', () => {
    const records = [
      rec('pipes', 3, 10, D3),
      rec('pipes', 10, 10, D1),
      rec('forms', 6, 10, D2)
    ];
    const a = selectReviewCandidate(CATALOG, ALL, records);
    const b = selectReviewCandidate(CATALOG, ALL, [...records].reverse());
    expect(a).toEqual(b);
    expect(a?.quizId).toBe('pipes');
  });

  it('computes the score from correct / total, rounded for display only', () => {
    expect(
      selectReviewCandidate(CATALOG, ALL, [rec('pipes', 1, 3, D1)])
        ?.latestPercent
    ).toBe(33);
    // 2/3 (66.7) is lower than 7/10 even though both round near 67-70.
    const r = selectReviewCandidate(CATALOG, ALL, [
      rec('pipes', 7, 10, D1),
      rec('forms', 2, 3, D1)
    ]);
    expect(r?.quizId).toBe('forms');
    expect(r?.latestPercent).toBe(67);
  });

  it('ignores Weak Areas Practice records', () => {
    const r = selectReviewCandidate(CATALOG, ALL, [
      rec('pipes', 8, 10, D1),
      rec('pipes', 0, 10, D3, 'weak-areas-practice'), // not a quiz attempt
      rec('forms', 9, 10, D1)
    ]);
    expect(r?.quizId).toBe('pipes');
    expect(r?.latestPercent).toBe(80);
  });

  it('ignores invalid records but keeps valid ones for the same quiz', () => {
    const bad = [
      rec('pipes', 5, 0, D3), // total 0
      rec('pipes', -1, 10, D3), // negative
      rec('pipes', 11, 10, D3), // correct > total
      rec('pipes', Number.NaN, 10, D3),
      rec('pipes', 5, 10, 'not-a-date'),
      rec('unknown', 0, 10, D3) // not in the catalog
    ];
    const r = selectReviewCandidate(CATALOG, ALL, [
      rec('pipes', 8, 10, D1),
      ...bad,
      rec('forms', 9, 10, D1)
    ]);
    expect(r?.quizId).toBe('pipes');
    expect(r?.latestPercent).toBe(80); // the valid D1 attempt
  });

  it('skips completed quizzes with no valid history and never invents one', () => {
    const r = selectReviewCandidate(CATALOG, ALL, [rec('forms', 5, 10, D1)]);
    expect(r?.quizId).toBe('forms'); // pipes/http have no data: skipped
  });

  it('returns null when no completed quiz has valid history', () => {
    expect(selectReviewCandidate(CATALOG, ALL, [])).toBeNull();
    expect(selectReviewCandidate(CATALOG, ALL, null)).toBeNull();
    expect(
      selectReviewCandidate(CATALOG, ALL, [
        rec('pipes', 1, 10, D1, 'weak-areas-practice'),
        rec('forms', 0, 0, D1)
      ])
    ).toBeNull();
  });

  it('considers only COMPLETED quizzes of the current catalog', () => {
    const r = selectReviewCandidate(CATALOG, new Set(['forms']), [
      rec('pipes', 0, 10, D1), // not completed here
      rec('forms', 9, 10, D1)
    ]);
    expect(r?.quizId).toBe('forms');
    expect(selectReviewCandidate(CATALOG, new Set(), [rec('forms', 1, 2, D1)])).toBeNull();
    expect(selectReviewCandidate([], ALL, [rec('forms', 1, 2, D1)])).toBeNull();
  });

  it('breaks ties deterministically: older attempt, then title, then id', () => {
    // Same score: the attempt made longest ago first.
    expect(
      selectReviewCandidate(CATALOG, ALL, [
        rec('forms', 5, 10, D2),
        rec('pipes', 5, 10, D1)
      ])?.quizId
    ).toBe('pipes');
    // Same score and time: alphabetical by title.
    expect(
      selectReviewCandidate(CATALOG, ALL, [
        rec('pipes', 5, 10, D1),
        rec('forms', 5, 10, D1)
      ])?.quizId
    ).toBe('forms');
    // Same title: by id.
    const dup = [quiz('b', 'Same'), quiz('a', 'Same')];
    expect(
      selectReviewCandidate(dup, new Set(['a', 'b']), [
        rec('b', 5, 10, D1),
        rec('a', 5, 10, D1)
      ])?.quizId
    ).toBe('a');
  });

  it('falls back to the quiz id when a title is missing', () => {
    const r = selectReviewCandidate(
      [{ quizId: 'x', difficulty: 'advanced' } as Quiz],
      new Set(['x']),
      [rec('x', 1, 2, D1)]
    );
    expect(r?.title).toBe('x');
    expect(r?.difficulty).toBe('advanced');
  });
});
