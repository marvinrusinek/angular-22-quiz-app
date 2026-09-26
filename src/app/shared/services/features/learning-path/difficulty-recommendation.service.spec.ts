import { Quiz } from '@shared/models';
import { DifficultyRecommendationService } from './difficulty-recommendation.service';

function quiz(quizId: string, difficulty: string): Quiz {
  return { quizId, milestone: quizId, difficulty } as unknown as Quiz;
}

// 4 beginner, 4 intermediate, 4 advanced.
const CATALOG: Quiz[] = [
  quiz('b1', 'beginner'), quiz('b2', 'beginner'), quiz('b3', 'beginner'), quiz('b4', 'beginner'),
  quiz('i1', 'intermediate'), quiz('i2', 'intermediate'), quiz('i3', 'intermediate'), quiz('i4', 'intermediate'),
  quiz('a1', 'advanced'), quiz('a2', 'advanced'), quiz('a3', 'advanced'), quiz('a4', 'advanced')
];

// Thresholds under test: 75% completion + 80 average.
describe('DifficultyRecommendationService', () => {
  let service: DifficultyRecommendationService;

  beforeEach(() => {
    service = new DifficultyRecommendationService();
  });

  const rec = (scores: Record<string, number>) => service.recommend(CATALOG, scores);

  it('recommends Beginner for a brand-new user (no progress)', () => {
    const r = rec({})!;
    expect(r.level).toBe('beginner');
    expect(r.message).toContain('Beginner');
    expect(r.action).toBeNull();
  });

  it('stays in Beginner while fewer than ~75% of Beginner quizzes are completed', () => {
    const r = rec({ b1: 100, b2: 100 })!;   // 2/4 = 50% < 75%
    expect(r.level).toBe('beginner');
    expect(r.message).toBe('Build confidence with more Beginner quizzes.');
  });

  it('stays in Beginner when completion is high but the average score is low', () => {
    const r = rec({ b1: 70, b2: 70, b3: 70 })!;   // 75% complete but avg 70 < 80
    expect(r.level).toBe('beginner');
    expect(r.message).toBe('Continue strengthening your Beginner fundamentals.');
  });

  it('recommends Intermediate once ~75% of Beginner is done with a strong average', () => {
    const r = rec({ b1: 90, b2: 90, b3: 85 })!;   // 75% complete, avg ~88 ≥ 80
    expect(r.level).toBe('intermediate');
    expect(r.message).toBe("You're ready for Intermediate Angular topics.");
    expect(r.action).toEqual({ label: 'Browse Intermediate Quizzes', kind: 'browse', difficulty: 'intermediate' });
  });

  it('recommends strengthening Intermediate when its average is low', () => {
    // Beginner passed; some Intermediate done but avg < 80.
    const r = rec({ b1: 90, b2: 90, b3: 90, b4: 90, i1: 60, i2: 65 })!;
    expect(r.level).toBe('intermediate');
    expect(r.message).toBe('Continue strengthening your Intermediate topics.');
  });

  it('recommends Advanced once Beginner + Intermediate are strong', () => {
    const r = rec({
      b1: 90, b2: 90, b3: 90, b4: 90,
      i1: 90, i2: 85, i3: 88
    })!;   // beginner 100%/avg90; intermediate 75%/avg~88
    expect(r.level).toBe('advanced');
    expect(r.message).toBe("You're ready to tackle Advanced Angular concepts.");
    expect(r.action?.difficulty).toBe('advanced');
  });

  it('recommends "Keep Improving" when Advanced is underway but the average drops', () => {
    const r = rec({
      b1: 90, b2: 90, b3: 90, b4: 90,
      i1: 90, i2: 90, i3: 90, i4: 90,
      a1: 55, a2: 60           // advanced underway, avg 57 < 80
    })!;
    expect(r.level).toBe('advanced');
    expect(r.message).toBe('Continue strengthening your Advanced knowledge.');
  });

  it('returns the completion state when ALL quizzes are completed', () => {
    const all: Record<string, number> = {};
    for (const q of CATALOG) all[q.quizId] = 90;
    const r = rec(all)!;
    expect(r.level).toBe('complete');
    expect(r.heading).toBe('Ready for Interview Mode?');
    // Its own interview-focused prompt — NOT the banner's completion sentence.
    expect(r.message).toBe('Build a mixed-topic interview and earn Interview Master.');
    expect(r.action).toEqual({ label: 'Build an Interview', kind: 'interview' });
  });

  it('handles mixed progress (advanced ready, one advanced done well) → ready for Advanced', () => {
    const r = rec({
      b1: 100, b2: 100, b3: 100, b4: 100,
      i1: 100, i2: 100, i3: 100, i4: 100,
      a1: 100                 // one advanced done, avg 100 (not < 80) → ready message
    })!;
    expect(r.level).toBe('advanced');
    expect(r.message).toBe("You're ready to tackle Advanced Angular concepts.");
  });

  it('uses the BEST score only — duplicate/repeated attempts never change the average', () => {
    // best-score store already holds one value per quiz; the average of a level
    // is computed from those, so there is nothing to double-count.
    const a = rec({ b1: 90, b2: 90, b3: 85 })!;              // avg ~88 → intermediate
    const b = rec({ b1: 90, b2: 90, b3: 85, b3_dupe: 10 } as any)!;  // stray non-catalog id ignored
    expect(a.level).toBe(b.level);
    expect(b.level).toBe('intermediate');
  });

  it('never returns an action that locks/hides quizzes (advisory only)', () => {
    const r = rec({ b1: 90, b2: 90, b3: 90 })!;
    expect(r.action?.kind === 'browse' || r.action?.kind === 'interview' || r.action === null).toBe(true);
  });

  it('returns null for an empty catalog (nothing to advise on)', () => {
    expect(service.recommend([], {})).toBeNull();
  });

  it('ignores non-numeric / non-catalog best-score entries', () => {
    const r = rec({ b1: 90, b2: 90, b3: 90, ghost: 100, bad: 'x' as unknown as number })!;
    expect(r.level).toBe('intermediate');   // only b1..b3 count → beginner passed
  });
});
