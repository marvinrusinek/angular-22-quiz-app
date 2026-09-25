import { inject, Injectable } from '@angular/core';
import { CanActivate, Router, UrlTree } from '@angular/router';

import { PracticeSessionService } from '@shared/services/features/practice/practice-session.service';

/**
 * Protects Practice Results. Access requires a SUBMITTED session carrying a
 * scored result.
 *
 * A refresh passes because the result is persisted in the session snapshot and
 * rehydrated on construction — Results is re-rendered from the stored score, not
 * recomputed. Once Back to Quizzes clears the snapshot, browser Back lands here
 * with nothing to show and is redirected to Quiz Selection, so an invalid
 * completed session can never be restored.
 */
@Injectable({ providedIn: 'root' })
export class PracticeResultGuard implements CanActivate {
  private readonly session = inject(PracticeSessionService);
  private readonly router = inject(Router);

  canActivate(): boolean | UrlTree {
    if (this.session.hasResult()) return true;
    // An ACTIVE session means the user got here without finishing — send them
    // back to the questions rather than to Quiz Selection.
    if (this.session.hasSession()) return this.router.createUrlTree(['/practice/weak-areas']);
    return this.router.createUrlTree(['/quiz']);
  }
}
