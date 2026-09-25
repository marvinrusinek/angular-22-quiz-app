import { Quiz } from '@shared/models/Quiz.model';
import { LearningPathService } from './learning-path.service';

/**
 * Plain instantiation (house style): the service is pure — it takes the catalog
 * + completed / in-progress sets and returns a recommendation, reading no
 * storage. Tests drive those sets directly.
 */
function quiz(quizId: string, milestone: string, difficulty: string): Quiz {
  return { quizId, milestone, difficulty } as unknown as Quiz;
}

// A representative slice of the real catalog (stable ids + the mapped chains).
const CATALOG: Quiz[] = [
  quiz('create-first-app', 'Creating your first app', 'beginner'),
  quiz('templates', 'Templates', 'beginner'),
  quiz('directives', 'Directives', 'beginner'),
  quiz('pipes', 'Pipes', 'beginner'),
  quiz('forms', 'Angular Forms', 'intermediate'),
  quiz('http', 'Angular HTTP', 'intermediate'),
  quiz('router', 'Angular Router', 'intermediate'),
  quiz('testing', 'Angular Testing', 'intermediate'),
  quiz('rxjs', 'RxJS', 'advanced'),
  quiz('signals', 'Angular Signals', 'advanced'),
  quiz('change-detection', 'Change Detection', 'advanced')
];

const set = (...ids: string[]): ReadonlySet<string> => new Set(ids);
const none: ReadonlySet<string> = new Set();

describe('LearningPathService', () => {
  let service: LearningPathService;

  beforeEach(() => {
    service = new LearningPathService();
  });

  // 1
  it('recommends the introductory Beginner quiz when there is no progress', () => {
    const s = service.recommend(CATALOG, none, none);
    expect(s.allComplete).toBe(false);
    expect(s.recommendation?.quizId).toBe('create-first-app');
    expect(s.recommendation?.actionLabel).toBe('Start Quiz');
  });

  // 2
  it('prioritises an in-progress quiz above everything else', () => {
    // http is in progress; create-first-app is completed (would otherwise map to
    // templates). In-progress wins.
    const s = service.recommend(CATALOG, set('create-first-app'), set('http'));
    expect(s.recommendation?.quizId).toBe('http');
    expect(s.recommendation?.actionLabel).toBe('Continue Quiz');
    expect(s.recommendation?.reason).toBe('Continue where you left off.');
  });

  // 3
  it('never recommends a quiz that is already completed', () => {
    // Complete the whole beginner chain except the last; the recommendation must
    // be an incomplete quiz, never a completed one.
    const completed = set('create-first-app', 'templates', 'directives', 'pipes');
    const s = service.recommend(CATALOG, completed, none);
    expect(completed.has(s.recommendation!.quizId)).toBe(false);
  });

  // 4
  it('recommends the mapped follow-up of a completed quiz', () => {
    // Completed templates → its follow-up is directives.
    const s = service.recommend(CATALOG, set('create-first-app', 'templates'), none);
    expect(s.recommendation?.quizId).toBe('directives');
    expect(s.recommendation?.reason).toContain('Templates');
  });

  // 5
  it('stays within the current difficulty when no mapped follow-up applies', () => {
    // Completed pipes (a beginner quiz with no follow-up map). Still < 75% of
    // beginner done → recommend another incomplete BEGINNER quiz.
    const s = service.recommend(CATALOG, set('pipes'), none);
    expect(s.recommendation?.difficulty).toBe('beginner');
    expect(s.recommendation?.quizId).not.toBe('pipes');
  });

  // 6
  it('advances to the next difficulty once ~75% of the level is completed', () => {
    // 3 of 4 beginner completed (75%). No mapped follow-up remains among them, so
    // it moves to Intermediate. (directives→component-tree not in this catalog.)
    const completed = set('create-first-app', 'templates', 'directives');
    const s = service.recommend(CATALOG, completed, none);
    expect(s.recommendation?.difficulty).toBe('intermediate');
    expect(s.recommendation?.reason).toContain('Intermediate');
  });

  // 7
  it('is unaffected by duplicate/repeated score records (a set already dedupes)', () => {
    // completedIds is a Set — the same quiz completed many times is one entry.
    const a = service.recommend(CATALOG, set('create-first-app', 'templates'), none);
    const b = service.recommend(CATALOG, set('templates', 'create-first-app', 'templates'), none);
    expect(a.recommendation?.quizId).toBe(b.recommendation?.quizId);
    expect(b.recommendation?.quizId).toBe('directives');
  });

  // 8
  it('ignores Interview Mode attempts (synthetic ids never match the catalog)', () => {
    // An interview assessment id in the sets must not be recommended or counted.
    const s = service.recommend(
      CATALOG,
      set('interview-1'),          // not a catalog quizId
      set('interview-session-x')   // not a catalog quizId
    );
    // No catalog quiz is completed → treated as a new user → intro quiz.
    expect(s.recommendation?.quizId).toBe('create-first-app');
    expect(s.allComplete).toBe(false);
  });

  // 9
  it('returns the all-complete state when every topic quiz is completed', () => {
    const completed = new Set(CATALOG.map((q) => q.quizId));
    const s = service.recommend(CATALOG, completed, none);
    expect(s.allComplete).toBe(true);
    expect(s.recommendation).toBeNull();
    expect(s.totalCount).toBe(CATALOG.length);
  });

  // 10
  it('fails safely when a mapped follow-up id is missing/renamed, falling back to another incomplete quiz', () => {
    // Catalog WITHOUT 'directives' (the mapped follow-up of templates). Completing
    // templates must not crash or recommend nothing — it falls through to another
    // incomplete quiz.
    const catalogNoDirectives = CATALOG.filter((q) => q.quizId !== 'directives');
    const s = service.recommend(catalogNoDirectives, set('create-first-app', 'templates'), none);
    expect(s.recommendation).not.toBeNull();
    expect(s.recommendation!.quizId).not.toBe('directives');
    expect(['create-first-app', 'templates']).not.toContain(s.recommendation!.quizId);
  });

  // extras — behaviour + edge safety
  it('returns nothing to recommend for an empty catalog (still loading)', () => {
    const s = service.recommend([], none, none);
    expect(s.recommendation).toBeNull();
    expect(s.allComplete).toBe(false);
    expect(s.totalCount).toBe(0);
  });

  it('walks a completed chain to its furthest incomplete step', () => {
    // Completed create-first-app + templates + directives → next is
    // component-tree, but it is not in this catalog; the mapped branch then finds
    // nothing, so difficulty logic takes over. Add component-tree to verify the
    // chain walk explicitly.
    const withTree = [...CATALOG, quiz('component-tree', 'Component Trees', 'intermediate')];
    const s = service.recommend(withTree, set('create-first-app', 'templates', 'directives'), none);
    expect(s.recommendation?.quizId).toBe('component-tree');
  });
});
