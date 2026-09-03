import { inject, Service } from '@angular/core';

import { OptionBindings } from '../../../models/OptionBindings.model';

import { QuizDotStatusService } from '../../flow/quiz-dot-status.service';
import { QuizService } from '../../data/quiz.service';
import { TimerService } from '../../features/timer/timer.service';

/**
 * Timer-expiry probes for option-item visual state.
 *
 * - Authoritative `isExpiredForQuestion`: cross-checks
 *   `TimerService.expiredForQuestionIndexSig` and a direct-subscription
 *   flag against the active qIdx, so a stale `timerExpired` input from a
 *   prior question can't bleed into the next.
 * - Stamp checks: the timer-expiry handler may pre-stamp CSS classes on
 *   bindings; stamps without a scoped `_timerExpiredStampedForIndex` are
 *   not trusted.
 *
 * ── Live expiry vs. arrival (revisit) ───────────────────────────────
 *
 * `expiredForQuestionIndexSig` alone cannot tell a question that JUST timed
 * out under the user's eyes apart from one they are merely REVISITING after
 * it already expired: `TimerService#expireImmediately()` (fired on arrival at
 * an already-past-deadline question, e.g. Previous back to it) sets
 * `expiredForQuestionIndexSig` to that index too. Without excluding the
 * arrival case, a revisit to an expired-but-UNANSWERED question kept reading
 * as a live expiry forever — `isTimerStamped()` returned true from the
 * binding's own never-cleared `_timerExpiredStamped` flag, so the option-item
 * kept painting the timeout's correct-answer reveal as if the user were still
 * looking at the moment it happened, even though a genuine revisit must show
 * only their own (here: empty) selection — the SAME "revisit is not a reveal"
 * contract `heading-inputs.ts`'s `isTimedOut` already enforces via
 * `expiredOnArrivalSig`, now applied here too.
 */
@Service()
export class OptionItemTimerStateService {
  private readonly quizService = inject(QuizService);
  private readonly timerService = inject(TimerService);
  private readonly dotStatusService = inject(QuizDotStatusService);

  /** True only for a LIVE expiry — the question expiring THIS visit, not a revisit to one already expired. */
  private isLiveExpiryForQuestion(qIdx: number): boolean {
    const expiredIdx = this.timerService.expiredForQuestionIndexSig();
    if (expiredIdx < 0 || expiredIdx !== qIdx) return false;
    return this.timerService.expiredOnArrivalSig() !== qIdx;
  }

  /**
   * The LOCK, unlike the REVEAL, must survive a revisit: a genuinely expired
   * question stays over forever, so re-enabling its options on a plain
   * Next → Previous round trip would let the user submit a fresh pick against
   * a question the clock already closed. `timedOutFetForced` (durable for the
   * whole session, cleared only on restart — see `quiz-dot-status.service.ts`)
   * is the established "this question's timeout already happened" marker used
   * elsewhere to guard against re-triggering the reveal pipeline on revisit;
   * it is exactly as durable as the lock needs to be, and unlike
   * `isLiveExpiryForQuestion` it stays true across the whole session, not just
   * the live moment.
   */
  hasQuestionEverExpired(qIdx: number): boolean {
    if (this.isLiveExpiryForQuestion(qIdx)) return true;
    return this.dotStatusService.timedOutFetForced.has(qIdx);
  }

  isExpiredForQuestion(
    qIdxInput: number,
    directExpired: boolean,
    directExpiredForIndex: number
  ): boolean {
    const qIdx = this.quizService.currentQuestionIndex ?? qIdxInput;

    if (this.isLiveExpiryForQuestion(qIdx)) return true;

    if (directExpired && directExpiredForIndex === qIdx) return true;

    return false;
  }

  isStamped(binding: OptionBindings | undefined, qIdxInput: number): boolean {
    const stamped = binding?._timerExpiredStamped;
    if (!stamped) return false;

    const stampedFor = binding?._timerExpiredStampedForIndex;
    if (stampedFor == null) return false;

    const qIdx = this.quizService.currentQuestionIndex ?? qIdxInput;
    if (stampedFor !== qIdx) return false;

    // A stamp from a LIVE expiry earlier this session is still trusted (the
    // binding itself hasn't changed), but only while this remains that same
    // live view. On a revisit/arrival the stamp is stale evidence of a reveal
    // that already happened, not one to keep re-showing.
    return this.isLiveExpiryForQuestion(qIdx);
  }

  isStampedCorrect(binding: OptionBindings | undefined, qIdxInput: number): boolean {
    return this.isStamped(binding, qIdxInput)
      && binding?.cssClasses?.['correct-option'] === true;
  }
}
