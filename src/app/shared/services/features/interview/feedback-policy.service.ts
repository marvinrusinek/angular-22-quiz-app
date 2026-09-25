import { Service, signal } from '@angular/core';

import { FeedbackMode } from '@shared/models/InterviewSession.model';

/**
 * Central switch for whether correctness feedback is shown immediately (normal
 * topic quizzes — the default) or DEFERRED until submission (Interview Mode).
 *
 * The shared rendering leaves — the heading model (`shouldShowFet`) and the
 * option-item feedback gates — consult this ONE signal instead of scattering
 * `if (isInterviewMode)` checks. The interview session sets it to 'deferred' for
 * the session's lifetime and back to 'immediate' on teardown; nothing else
 * writes it, so every non-interview screen keeps its existing behavior.
 */
@Service()
export class FeedbackPolicyService {
  private readonly _mode = signal<FeedbackMode>('immediate');
  readonly feedbackMode = this._mode.asReadonly();

  // Convenience for the many call sites that only care whether feedback is held.
  readonly isDeferred = () => this._mode() === 'deferred';

  setMode(mode: FeedbackMode): void {
    this._mode.set(mode);
  }

  reset(): void {
    this._mode.set('immediate');
  }
}
