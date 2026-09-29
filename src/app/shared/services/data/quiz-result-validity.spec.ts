import { signal } from '@angular/core';

import { QuizService } from './quiz.service';
import { SK_RESULTS_REACHED_ATTEMPT } from '@shared/constants/session-keys';
import { toDurableFinalResult, type FinalResult } from '@shared/models/Final-Result.model';

/**
 * Regression coverage for the direct-route Results bypass (Finding 1 of the
 * final audit): a direct/stale navigation to `/quiz/results/:quizId` for a
 * quiz that was never actually completed — or whose route quizId doesn't
 * match the quiz that WAS completed — must not be treated as a valid result.
 * QuizResultGuard and ResultsComponent both gate on
 * `QuizService.hasValidResultFor`, so these tests exercise that method
 * directly, in isolation from QuizService's large constructor/DI graph
 * (Object.create sidesteps the constructor entirely — hasValidResultFor and
 * getFinalResultSnapshot only ever touch the three fields set up below).
 */
describe('QuizService#hasValidResultFor', () => {
  let svc: QuizService;

  function makeService(totalQuestions: number, attemptId: string): QuizService {
    const instance = Object.create(QuizService.prototype) as QuizService;
    (instance as any).finalResultSig = signal<FinalResult | null>(null);
    (instance as any).totalQuestions = signal(totalQuestions);
    (instance as any).getCurrentAttemptId = () => attemptId;
    return instance;
  }

  function persistSnapshot(result: FinalResult): void {
    sessionStorage.setItem('finalResult', JSON.stringify(toDurableFinalResult(result)));
  }

  afterEach(() => {
    sessionStorage.clear();
  });

  it('no completed attempt at all: no snapshot, no live progress — invalid', () => {
    svc = makeService(0, '');
    expect(svc.hasValidResultFor('quizC')).toBe(false);
  });

  it('a persisted snapshot for THIS quiz is valid (normal completion, and refresh/revisit of it)', () => {
    svc = makeService(0, 'att1');
    persistSnapshot({
      quizId: 'quizA',
      correct: 5,
      total: 5,
      percentage: 100,
      analysis: [],
      completedAt: Date.now(),
    });

    // Simulates both the initial completion AND a later refresh/revisit —
    // hasValidResultFor is a pure read, so re-checking it must keep agreeing.
    expect(svc.hasValidResultFor('quizA')).toBe(true);
    expect(svc.hasValidResultFor('quizA')).toBe(true);
  });

  it("Quiz A completed, then Quiz B's route is checked: A's snapshot must NOT validate B", () => {
    svc = makeService(0, 'att1');
    persistSnapshot({
      quizId: 'quizA',
      correct: 5,
      total: 5,
      percentage: 100,
      analysis: [],
      completedAt: Date.now(),
    });

    expect(svc.hasValidResultFor('quizB')).toBe(false);
  });

  it('a fresh completion not yet snapshotted is valid via the results-reached marker for THIS exact quiz+attempt', () => {
    svc = makeService(5, 'att-fresh');
    sessionStorage.setItem(SK_RESULTS_REACHED_ATTEMPT, 'quizA|att-fresh');

    expect(svc.hasValidResultFor('quizA')).toBe(true);
  });

  it('the results-reached marker belongs to a DIFFERENT quiz — direct nav to that other quiz is invalid', () => {
    svc = makeService(5, 'att-fresh');
    // Quiz A's real last-question flow wrote this marker; nothing has ever
    // legitimately completed Quiz B.
    sessionStorage.setItem(SK_RESULTS_REACHED_ATTEMPT, 'quizA|att-fresh');

    expect(svc.hasValidResultFor('quizB')).toBe(false);
  });

  it('the results-reached marker belongs to a DIFFERENT (older) attempt of the SAME quiz — invalid', () => {
    svc = makeService(5, 'att-new');
    sessionStorage.setItem(SK_RESULTS_REACHED_ATTEMPT, 'quizA|att-old');

    expect(svc.hasValidResultFor('quizA')).toBe(false);
  });

  it('no marker and no snapshot, even with live totalQuestions > 0 — invalid (nothing proves completion)', () => {
    svc = makeService(5, 'att1');
    expect(svc.hasValidResultFor('quizA')).toBe(false);
  });

  it('empty quizId is always invalid', () => {
    svc = makeService(5, 'att1');
    sessionStorage.setItem(SK_RESULTS_REACHED_ATTEMPT, '|att1');
    expect(svc.hasValidResultFor('')).toBe(false);
  });
});
