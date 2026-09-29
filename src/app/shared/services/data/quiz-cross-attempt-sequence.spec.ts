import { signal } from '@angular/core';

import { QuizService } from './quiz.service';
import { QuizScoringService } from './quiz-scoring.service';
import { SK_RESULTS_REACHED_ATTEMPT } from '@shared/constants/session-keys';
import { toDurableFinalResult, type FinalResult } from '@shared/models/Final-Result.model';

/**
 * Regression coverage for the specific cross-attempt edge the direct-route
 * Results fix (Finding 1) needed to hold up against: completing Quiz A,
 * starting a genuinely NEW Quiz B attempt (a different attemptId), then
 * directly opening Quiz A's results URL mid-B, before returning to complete
 * B for real. Exercises QuizService.hasValidResultFor and
 * QuizScoringService.recordCompletedQuizScore exactly as
 * setCompletedQuiz()/QuizResultGuard and ngOnInit's High-Score write use
 * them, and checks the snapshot, current attempt id, results-reached marker,
 * and High Scores after each step — not just the final state.
 *
 * Key fact this test relies on (verified directly in
 * quiz-persistence.service.ts#clearAllForFreshStart): starting a fresh quiz
 * attempt clears the PERSISTED SNAPSHOT ('finalResult') but does NOT clear
 * SK_RESULTS_REACHED_ATTEMPT — that marker is only ever overwritten by a
 * genuine completion (quiz.component.ts#markResultsReached), never cleared on
 * start. So Quiz A's marker is left stale (still naming attempt A) once
 * Quiz B starts, and hasValidResultFor must reject it via the attemptId
 * mismatch, not merely the quizId mismatch.
 */
function makeQuizService(totalQuestions: number, attemptId: string): QuizService {
  const instance = Object.create(QuizService.prototype) as QuizService;
  (instance as any).finalResultSig = signal<FinalResult | null>(null);
  (instance as any).totalQuestions = signal(totalQuestions);
  (instance as any).getCurrentAttemptId = () => attemptId;
  return instance;
}

function makeScoringService(): QuizScoringService {
  const instance = Object.create(QuizScoringService.prototype) as QuizScoringService;
  (instance as any).highScoresLocal = [];
  return instance;
}

function persistSnapshot(result: FinalResult): void {
  sessionStorage.setItem('finalResult', JSON.stringify(toDurableFinalResult(result)));
}

describe('Cross-attempt sequence: A completed -> B started (new attemptId) -> direct nav to A mid-B -> B completes', () => {
  afterEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  it('produces exactly one row per quiz, with no cross-attribution in either direction', () => {
    const attA = 'att-A-1';
    const attB = 'att-B-2';
    const scoringSvc = makeScoringService();

    // ── Step 1: Complete Quiz A ─────────────────────────────────────────
    let quizSvc = makeQuizService(5, attA);
    sessionStorage.setItem(SK_RESULTS_REACHED_ATTEMPT, `quizA|${attA}`); // markResultsReached('quizA')

    expect(quizSvc.hasValidResultFor('quizA')).toBe(true); // fresh-completion path (no snapshot yet)

    const snapshotA: FinalResult = {
      quizId: 'quizA', correct: 5, total: 5, percentage: 100, analysis: [], completedAt: Date.now(),
    };
    persistSnapshot(snapshotA);
    scoringSvc.recordCompletedQuizScore('quizA', snapshotA.percentage, snapshotA.total, attA);

    expect(quizSvc.getCurrentAttemptId()).toBe(attA);
    expect(sessionStorage.getItem('finalResult')).not.toBeNull();
    expect(scoringSvc.highScoresLocal).toHaveLength(1);
    expect(scoringSvc.highScoresLocal[0]).toMatchObject({ quizId: 'quizA', attemptId: attA, score: 100, totalQuestions: 5 });

    // ── Step 2: Start a NEW Quiz B attempt (different attemptId) ────────
    // Mirrors resetQuizForFreshStart(): startNewAttempt() mints attB;
    // clearAllForFreshStart('quizB') clears the persisted snapshot but
    // leaves SK_RESULTS_REACHED_ATTEMPT untouched (verified against the
    // real implementation — see the file doc comment above).
    sessionStorage.removeItem('finalResult');
    quizSvc = makeQuizService(4, attB);

    expect(quizSvc.getCurrentAttemptId()).toBe(attB);
    expect(sessionStorage.getItem('finalResult')).toBeNull();
    expect(sessionStorage.getItem(SK_RESULTS_REACHED_ATTEMPT)).toBe(`quizA|${attA}`); // stale, unchanged

    // ── Step 3: Before completing B, directly open /quiz/results/quizA ──
    // No snapshot (cleared in step 2), and the stale marker names att A,
    // not the CURRENT attempt (attB) — must be rejected.
    expect(quizSvc.hasValidResultFor('quizA')).toBe(false);

    // A denied request must never touch state: A's own row and B's absence
    // are both unaffected by merely attempting this navigation.
    expect(scoringSvc.highScoresLocal).toHaveLength(1);
    expect(scoringSvc.highScoresLocal[0].attemptId).toBe(attA);
    expect(sessionStorage.getItem(SK_RESULTS_REACHED_ATTEMPT)).toBe(`quizA|${attA}`);

    // ── Step 4: Return to B, complete it for real ───────────────────────
    sessionStorage.setItem(SK_RESULTS_REACHED_ATTEMPT, `quizB|${attB}`); // markResultsReached('quizB')
    expect(quizSvc.hasValidResultFor('quizB')).toBe(true);

    scoringSvc.recordCompletedQuizScore('quizB', 75, 4, attB);

    // ── Final state: both rows present, correctly attributed ────────────
    expect(scoringSvc.highScoresLocal).toHaveLength(2);
    const byAttempt = Object.fromEntries(
      scoringSvc.highScoresLocal.map((r: any) => [r.attemptId, r])
    );
    expect(byAttempt[attA]).toMatchObject({ quizId: 'quizA', totalQuestions: 5, score: 100 });
    expect(byAttempt[attB]).toMatchObject({ quizId: 'quizB', totalQuestions: 4, score: 75 });

    // No Quiz A row was ever created attributed to B's attempt id, and
    // vice versa.
    expect(scoringSvc.highScoresLocal.some((r: any) => r.quizId === 'quizA' && r.attemptId === attB)).toBe(false);
    expect(scoringSvc.highScoresLocal.some((r: any) => r.quizId === 'quizB' && r.attemptId === attA)).toBe(false);
  });

  it('re-viewing/refreshing B\'s own results after completion does not duplicate its row', () => {
    const attB = 'att-B-3';
    const scoringSvc = makeScoringService();
    const quizSvc = makeQuizService(4, attB);

    sessionStorage.setItem(SK_RESULTS_REACHED_ATTEMPT, `quizB|${attB}`);
    const snapshotB: FinalResult = {
      quizId: 'quizB', correct: 3, total: 4, percentage: 75, analysis: [], completedAt: Date.now(),
    };
    persistSnapshot(snapshotB);

    // First load, then a refresh/revisit — same attemptId both times.
    scoringSvc.recordCompletedQuizScore('quizB', 75, 4, attB);
    expect(quizSvc.hasValidResultFor('quizB')).toBe(true);
    scoringSvc.recordCompletedQuizScore('quizB', 75, 4, attB);

    expect(scoringSvc.highScoresLocal).toHaveLength(1);
  });
});
