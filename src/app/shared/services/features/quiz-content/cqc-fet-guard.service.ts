import { Service, inject } from '@angular/core';

import { QuizDotStatusService } from '../../flow/quiz-dot-status.service';

import type { CodelabQuizContentComponent } from '../../../../containers/quiz/quiz-content/codelab-quiz-content.component';

type Host = CodelabQuizContentComponent;

/**
 * FET interaction-evidence check, extracted from CqcOrchestratorService.
 *
 * The heading is now rendered by the single-source `headingHtml` computed, so the
 * former gate chain / writeQText / DOM watchdog have all been removed; only the
 * interaction-evidence check remains (still consulted by cqc-question-nav).
 *
 * Responsible for:
 * - hasInteractionEvidence: does this index have evidence the FET should show?
 */
@Service()
export class CqcFetGuardService {
  // ── injects ─────────────────────────────────────────────────────
  private dotStatusService = inject(QuizDotStatusService);

  /**
   * Does this index have concrete evidence that FET should be showing?
   */
  hasInteractionEvidence(host: Host, idx: number): boolean {
    try {
      // Treat a timer-expired-without-answer question as interaction evidence —
      // when the timer auto-resolves a question the FET must show, and must
      // persist across tab visibility cycles. Without this, the visibility
      // restamp computes the question text instead of the FET and overwrites
      // the heading on tab return.
      if (this.dotStatusService.timerExpiredUnanswered?.has(idx)) return true;
      // SOC-set bypass flags are definitive interaction evidence — SOC only
      // sets them after verifying user-clicked selections satisfy the
      // question. Without this, a click→FET race in shuffled mode can leave
      // hasClickedInSession unset at the moment displayText$ emits the FET,
      // causing gates here to block the FET write.
      if (host.explanationTextService?.fetBypassForQuestion?.get(idx) === true) return true;
      if (host.quizService?.questionResolved?.get(idx) === true) return true;
      return !!host.quizStateService.hasClickedInSession?.(idx);
    } catch {
      return false;
    }
  }

}
