import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, Router, RouterStateSnapshot, UrlTree } from '@angular/router';
import { of } from 'rxjs';

import { QuizGuard } from './quiz-guard';
import { TopicQuizMetadataService } from '@shared/services/api/topic-quiz-metadata.service';
import { QuizService } from '@shared/services/data/quiz.service';
import { QuizProgressionService } from '@shared/services/flow/quiz-progression.service';

/**
 * S6h — the guard no longer reads the bundled answer-bearing bank via
 * QuizDataService.getCachedQuizById()/getCurrentQuizSnapshot(). Index
 * validation now comes from TopicQuizMetadataService.questionCountByQuiz(),
 * the same API-backed metadata source the resolver already uses.
 *
 * `progressionService` defaults to "everything unlocked" (MAX_SAFE_INTEGER)
 * so every pre-existing test below keeps testing exactly what it always
 * tested — pure range validation — undisturbed by the progression check. The
 * dedicated `describe('progression gate — direct-route bypass')` block below
 * overrides it to specific values to test THAT check in isolation.
 */
describe('QuizGuard', () => {
  let guard: QuizGuard;
  let router: any;
  let metadataApi: any;
  let quizService: any;
  let progressionService: any;

  const mockRouterState = {} as RouterStateSnapshot;
  const mockUrlTree = new UrlTree();

  function makeRoute(params: Record<string, string>): ActivatedRouteSnapshot {
    return { params } as unknown as ActivatedRouteSnapshot;
  }

  function setCounts(counts: Record<string, number | null>): void {
    metadataApi.questionCountByQuiz.mockReturnValue(new Map(Object.entries(counts)));
  }

  beforeEach(() => {
    router = { createUrlTree: jest.fn().mockReturnValue(mockUrlTree) };

    metadataApi = {
      load: jest.fn().mockReturnValue(of([])),
      questionCountByQuiz: jest.fn().mockReturnValue(new Map()),
    };

    quizService = { questions: [] };

    progressionService = {
      getFurthestUnlocked: jest.fn().mockReturnValue(Number.MAX_SAFE_INTEGER),
    };

    TestBed.configureTestingModule({
      providers: [
        QuizGuard,
        { provide: Router, useValue: router },
        { provide: TopicQuizMetadataService, useValue: metadataApi },
        { provide: QuizService, useValue: quizService },
        { provide: QuizProgressionService, useValue: progressionService },
      ],
    });
    guard = TestBed.inject(QuizGuard);
  });

  it('should be created', () => {
    expect(guard).toBeTruthy();
  });

  it('redirects to /quiz when quizId is missing — no metadata call made', (done) => {
    (guard.canActivate(makeRoute({}), mockRouterState) as any).subscribe((result: unknown) => {
      expect(router.createUrlTree).toHaveBeenCalledWith(['/quiz']);
      expect(result).toBeInstanceOf(UrlTree);
      expect(metadataApi.load).not.toHaveBeenCalled();
      done();
    });
  });

  it('redirects to question 1 when questionIndex is missing — no metadata call made', (done) => {
    (guard.canActivate(makeRoute({ quizId: 'angular' }), mockRouterState) as any).subscribe(() => {
      expect(router.createUrlTree).toHaveBeenCalledWith(['/quiz/question', 'angular', 1]);
      expect(metadataApi.load).not.toHaveBeenCalled();
      done();
    });
  });

  it('redirects to intro when questionIndex is non-numeric (malformed)', (done) => {
    (guard.canActivate(
      makeRoute({ quizId: 'angular', questionIndex: 'abc' }),
      mockRouterState
    ) as any).subscribe(() => {
      expect(router.createUrlTree).toHaveBeenCalledWith(['/quiz/intro', 'angular']);
      done();
    });
  });

  it('redirects to question 1 when questionIndex < 1 (invalid low)', (done) => {
    (guard.canActivate(
      makeRoute({ quizId: 'angular', questionIndex: '0' }),
      mockRouterState
    ) as any).subscribe(() => {
      expect(router.createUrlTree).toHaveBeenCalledWith(['/quiz/question', 'angular', 1]);
      done();
    });
  });

  it('allows navigation when the quiz is unknown to metadata (let resolver load/redirect)', (done) => {
    setCounts({});
    (guard.canActivate(
      makeRoute({ quizId: 'angular', questionIndex: '1' }),
      mockRouterState
    ) as any).subscribe((result: unknown) => {
      expect(result).toBe(true);
      done();
    });
  });

  it('allows navigation for the first question', (done) => {
    setCounts({ angular: 3 });
    (guard.canActivate(
      makeRoute({ quizId: 'angular', questionIndex: '1' }),
      mockRouterState
    ) as any).subscribe((result: unknown) => {
      expect(result).toBe(true);
      done();
    });
  });

  it('allows navigation for a middle question', (done) => {
    setCounts({ angular: 3 });
    (guard.canActivate(
      makeRoute({ quizId: 'angular', questionIndex: '2' }),
      mockRouterState
    ) as any).subscribe((result: unknown) => {
      expect(result).toBe(true);
      done();
    });
  });

  it('allows navigation for the last question', (done) => {
    setCounts({ angular: 3 });
    (guard.canActivate(
      makeRoute({ quizId: 'angular', questionIndex: '3' }),
      mockRouterState
    ) as any).subscribe((result: unknown) => {
      expect(result).toBe(true);
      done();
    });
  });

  it('clamps an out-of-bounds (too high) question index to the max', (done) => {
    setCounts({ angular: 2 });
    (guard.canActivate(
      makeRoute({ quizId: 'angular', questionIndex: '5' }),
      mockRouterState
    ) as any).subscribe(() => {
      expect(router.createUrlTree).toHaveBeenCalledWith(['/quiz/question', 'angular', 2]);
      done();
    });
  });

  it('a quiz known to metadata but with no reported count is treated as unknown (deferred)', (done) => {
    setCounts({ angular: null });
    (guard.canActivate(
      makeRoute({ quizId: 'angular', questionIndex: '5' }),
      mockRouterState
    ) as any).subscribe((result: unknown) => {
      expect(result).toBe(true);
      done();
    });
  });

  it('falls back to QuizService.questions.length when it exceeds the metadata count', (done) => {
    setCounts({ angular: 2 });
    quizService.questions = [{}, {}, {}, {}]; // 4 live questions, metadata says 2
    (guard.canActivate(
      makeRoute({ quizId: 'angular', questionIndex: '4' }),
      mockRouterState
    ) as any).subscribe((result: unknown) => {
      expect(result).toBe(true); // index 4 is in range once the live count is used
      done();
    });
  });

  it('a metadata/API failure never throws — TopicQuizMetadataService.load() fails soft to []', (done) => {
    metadataApi.load.mockReturnValue(of([])); // load() never rejects (fails soft), mirrors production
    setCounts({});
    (guard.canActivate(
      makeRoute({ quizId: 'angular', questionIndex: '1' }),
      mockRouterState
    ) as any).subscribe((result: unknown) => {
      expect(result).toBe(true); // unknown-to-metadata path — resolver handles it
      done();
    });
  });

  it('requires no QuizDataService and no bank Quiz object — the guard only calls metadataApi + quizService.questions', (done) => {
    setCounts({ angular: 3 });
    (guard.canActivate(
      makeRoute({ quizId: 'angular', questionIndex: '2' }),
      mockRouterState
    ) as any).subscribe(() => {
      expect(metadataApi.load).toHaveBeenCalled();
      expect(metadataApi.questionCountByQuiz).toHaveBeenCalled();
      done();
    });
  });

  describe('progression gate — direct-route bypass', () => {
    it('a brand-new attempt (furthest=1) allows question 1', (done) => {
      setCounts({ angular: 3 });
      progressionService.getFurthestUnlocked.mockReturnValue(1);
      (guard.canActivate(
        makeRoute({ quizId: 'angular', questionIndex: '1' }),
        mockRouterState
      ) as any).subscribe((result: unknown) => {
        expect(result).toBe(true);
        expect(router.createUrlTree).not.toHaveBeenCalled();
        done();
      });
    });

    it('a brand-new attempt (furthest=1) rejects a direct request for question 2 — redirects to the furthest UrlTree, never true', (done) => {
      setCounts({ angular: 3 });
      progressionService.getFurthestUnlocked.mockReturnValue(1);
      (guard.canActivate(
        makeRoute({ quizId: 'angular', questionIndex: '2' }),
        mockRouterState
      ) as any).subscribe((result: unknown) => {
        expect(router.createUrlTree).toHaveBeenCalledWith(['/quiz/question', 'angular', 1]);
        expect(result).toBeInstanceOf(UrlTree);
        expect(result).not.toBe(true);
        done();
      });
    });

    it('an in-range but not-yet-earned question (e.g. furthest=2, requesting 5 of 6) redirects to the furthest unlocked index, not the requested one', (done) => {
      setCounts({ angular: 6 });
      progressionService.getFurthestUnlocked.mockReturnValue(2);
      (guard.canActivate(
        makeRoute({ quizId: 'angular', questionIndex: '5' }),
        mockRouterState
      ) as any).subscribe((result: unknown) => {
        expect(router.createUrlTree).toHaveBeenCalledWith(['/quiz/question', 'angular', 2]);
        expect(result).toBeInstanceOf(UrlTree);
        done();
      });
    });

    it('requesting exactly the furthest-unlocked index is allowed (the boundary is inclusive)', (done) => {
      setCounts({ angular: 6 });
      progressionService.getFurthestUnlocked.mockReturnValue(3);
      (guard.canActivate(
        makeRoute({ quizId: 'angular', questionIndex: '3' }),
        mockRouterState
      ) as any).subscribe((result: unknown) => {
        expect(result).toBe(true);
        done();
      });
    });

    it('requesting any already-unlocked question behind the furthest (revisit/backward nav) is allowed', (done) => {
      setCounts({ angular: 6 });
      progressionService.getFurthestUnlocked.mockReturnValue(4);
      (guard.canActivate(
        makeRoute({ quizId: 'angular', questionIndex: '2' }),
        mockRouterState
      ) as any).subscribe((result: unknown) => {
        expect(result).toBe(true);
        done();
      });
    });

    it('malformed/out-of-range index handling runs BEFORE the progression check — a non-numeric index still redirects to intro, not through getFurthestUnlocked', (done) => {
      setCounts({ angular: 3 });
      progressionService.getFurthestUnlocked.mockReturnValue(1);
      (guard.canActivate(
        makeRoute({ quizId: 'angular', questionIndex: 'nope' }),
        mockRouterState
      ) as any).subscribe(() => {
        expect(router.createUrlTree).toHaveBeenCalledWith(['/quiz/intro', 'angular']);
        expect(progressionService.getFurthestUnlocked).not.toHaveBeenCalled();
        done();
      });
    });

    it('the progression check is consulted with the resolved quizId and the best-known total question count', (done) => {
      setCounts({ angular: 3 });
      quizService.questions = [{}, {}, {}, {}]; // live count (4) exceeds metadata (3)
      progressionService.getFurthestUnlocked.mockReturnValue(1);
      (guard.canActivate(
        makeRoute({ quizId: 'angular', questionIndex: '4' }),
        mockRouterState
      ) as any).subscribe(() => {
        expect(progressionService.getFurthestUnlocked).toHaveBeenCalledWith('angular', 4);
        done();
      });
    });

    it('a direct Router.navigate() to a locked URL cannot bypass the guard — canActivate itself resolves a redirect UrlTree, not `true`, so the target route never activates', (done) => {
      setCounts({ angular: 6 });
      progressionService.getFurthestUnlocked.mockReturnValue(1);
      (guard.canActivate(
        makeRoute({ quizId: 'angular', questionIndex: '6' }),
        mockRouterState
      ) as any).subscribe((result: unknown) => {
        expect(result).toBeInstanceOf(UrlTree);
        expect(result).not.toBe(true);
        expect(router.createUrlTree).toHaveBeenCalledWith(['/quiz/question', 'angular', 1]);
        done();
      });
    });

    it('redirecting to the furthest unlocked index cannot loop — re-evaluating the guard against that same redirect target resolves true', (done) => {
      setCounts({ angular: 6 });
      progressionService.getFurthestUnlocked.mockReturnValue(2);
      (guard.canActivate(
        makeRoute({ quizId: 'angular', questionIndex: '2' }),
        mockRouterState
      ) as any).subscribe((result: unknown) => {
        // This is the exact target the prior over-request redirected to —
        // proving re-evaluating the guard against it settles at `true`
        // instead of redirecting again.
        expect(result).toBe(true);
        done();
      });
    });
  });
});
