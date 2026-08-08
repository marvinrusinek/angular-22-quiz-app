import { Service, inject } from '@angular/core';

import { SelectedOptionService } from '../../state/selectedoption.service';
import { TimerService } from './timer.service';
import { TopicQuizAttemptService } from '../verdict/topic-quiz-attempt.service';

/**
 * The one place a live Topic Quiz countdown is allowed to begin.
 *
 * ── Why this exists ────────────────────────────────────────────────
 *
 * A Topic Quiz timeout is a claim ("this question's 30 seconds are up") that
 * the server has to believe before it will hand back the correct answers. It
 * believes it only if the reveal arrives at or after the deadline in the
 * question's signed receipt. The client used to start a local 30-second timer
 * the instant a question rendered, and mint the receipt lazily on the FIRST
 * `/check` — which, for an unanswered question, IS the timeout reveal. So the
 * server's window opened as the client's closed, the reveal landed ~30 seconds
 * early, and the backend correctly refused it. Nothing painted.
 *
 * So the order is inverted: get the deadline first, then count down to it.
 *
 * ── Two callers, one authority ─────────────────────────────────────
 *
 * Questions become active down two paths that share no seam below them (the
 * direct route, and the QQC stream), so both call in here. That is not two
 * timing authorities: the receipt cache is keyed by question text and issued
 * at most once, so whichever path arrives first defines the deadline and the
 * other replays it.
 *
 * ── What it deliberately does not do ───────────────────────────────
 *
 * No scoring, no correctness, no fetching, no persistence. It answers one
 * question — "when is this question over?" — and hands the answer to the timer.
 */
@Service()
export class QuestionTimingService {
  private readonly attempts = inject(TopicQuizAttemptService);
  private readonly selectedOptionService = inject(SelectedOptionService);
  private readonly timerService = inject(TimerService);

  /**
   * Called when a question becomes the active one.
   *
   * Safe to call repeatedly for the same question: a duplicate activation
   * replays the cached deadline instead of buying another 30 seconds.
   */
  activateQuestionTiming(
    quizId: string | null | undefined,
    questionText: string | null | undefined,
    questionIndex: number
  ): void {
    if (!quizId || !questionText || questionIndex == null || questionIndex < 0) return;

    // An already-correct question shows the time it was answered in, frozen.
    // Checked from the durable dot status — the same authority the rest of the
    // app uses for "was this answered correctly" — never from the option data,
    // which no longer carries correctness on the client.
    if (this.isAnsweredCorrectly(questionIndex)) {
      this.timerService.freezeAtRecordedTime(questionIndex);
      return;
    }

    this.attempts.startQuestion(quizId, questionText).subscribe({
      next: ({ deadlineMs }) => {
        this.timerService.setAuthorizedDeadline(questionIndex, deadlineMs);

        // Re-check rather than assume: the user can answer while the receipt
        // is still in flight, and that answer wins over a stale activation.
        if (this.isAnsweredCorrectly(questionIndex)) {
          this.timerService.freezeAtRecordedTime(questionIndex);
          return;
        }

        this.timerService.restartForQuestion(questionIndex);
      },
      error: () => {
        // No authorized deadline means no authorized timeout. Leaving the timer
        // unstarted is the honest outcome: a local countdown here would expire
        // into a reveal the server would reject anyway, and inventing one that
        // it WOULD accept is the answer leak this design exists to close.
      }
    });
  }

  /** Drops every deadline. For a restart or a quiz switch — both new attempts. */
  clearTiming(): void {
    this.attempts.clear();
    this.timerService.clearAuthorizedDeadlines();
  }

  private isAnsweredCorrectly(questionIndex: number): boolean {
    return (
      this.selectedOptionService?.clickConfirmedDotStatus?.get?.(questionIndex) === 'correct'
    );
  }
}
