import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, convertToParamMap, Router, UrlTree } from '@angular/router';

import { QuizResultGuard } from './quiz-result-guard';
import { QuizService } from '@shared/services/data/quiz.service';

/**
 * Regression coverage for the direct-route Results bypass: navigating to
 * `/quiz/results/:quizId` for a quiz that was never actually completed (or
 * whose route quizId doesn't match the quiz that WAS completed) must never
 * activate the route. The guard delegates the actual validity rule to
 * QuizService.hasValidResultFor — these tests only verify the guard reads the
 * right quizId and reacts correctly to that decision.
 */
describe('QuizResultGuard', () => {
  let guard: QuizResultGuard;
  let router: any;
  let quizService: any;

  const mockUrlTree = new UrlTree();

  function makeRoute(quizId: string | null): ActivatedRouteSnapshot {
    return {
      paramMap: convertToParamMap(quizId ? { quizId } : {}),
    } as unknown as ActivatedRouteSnapshot;
  }

  beforeEach(() => {
    router = { createUrlTree: jest.fn().mockReturnValue(mockUrlTree) };
    quizService = { hasValidResultFor: jest.fn().mockReturnValue(false) };

    TestBed.configureTestingModule({
      providers: [
        QuizResultGuard,
        { provide: Router, useValue: router },
        { provide: QuizService, useValue: quizService },
      ],
    });
    guard = TestBed.inject(QuizResultGuard);
  });

  it('is created', () => {
    expect(guard).toBeTruthy();
  });

  it('redirects to /quiz when quizId is missing — no validity check made', () => {
    const result = guard.canActivate(makeRoute(null));
    expect(router.createUrlTree).toHaveBeenCalledWith(['/quiz']);
    expect(result).toBe(mockUrlTree);
    expect(quizService.hasValidResultFor).not.toHaveBeenCalled();
  });

  it('allows a route whose quizId has a valid completed result', () => {
    quizService.hasValidResultFor.mockReturnValue(true);
    const result = guard.canActivate(makeRoute('quizA'));
    expect(quizService.hasValidResultFor).toHaveBeenCalledWith('quizA');
    expect(result).toBe(true);
    expect(router.createUrlTree).not.toHaveBeenCalled();
  });

  it('Quiz A completed, then direct navigation to Quiz B\'s results URL: redirected to Quiz B\'s intro, never activated', () => {
    // hasValidResultFor('quizB') is false because Quiz B was never completed
    // (only Quiz A was) — the guard must never let this route activate.
    quizService.hasValidResultFor.mockImplementation((id: string) => id === 'quizA');

    const result = guard.canActivate(makeRoute('quizB'));

    expect(quizService.hasValidResultFor).toHaveBeenCalledWith('quizB');
    expect(router.createUrlTree).toHaveBeenCalledWith(['/quiz/intro', 'quizB']);
    expect(result).toBe(mockUrlTree);
    expect(result).not.toBe(true);
  });

  it('direct results navigation with no completed attempt at all: redirected to that quiz\'s intro', () => {
    quizService.hasValidResultFor.mockReturnValue(false);
    const result = guard.canActivate(makeRoute('quizC'));
    expect(router.createUrlTree).toHaveBeenCalledWith(['/quiz/intro', 'quizC']);
    expect(result).toBe(mockUrlTree);
  });

  it('a genuine revisit/refresh of the same completed quiz keeps being allowed', () => {
    quizService.hasValidResultFor.mockReturnValue(true);
    const first = guard.canActivate(makeRoute('quizA'));
    const second = guard.canActivate(makeRoute('quizA'));
    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(router.createUrlTree).not.toHaveBeenCalled();
  });
});
