import { inject, Injectable } from '@angular/core';
import { CanActivate, Router, UrlTree } from '@angular/router';

import { PracticeSessionService } from '@shared/services/features/practice/practice-session.service';

/**
 * Protects the Weak Areas Practice route. Access requires a generated session
 * with at least one question — the session is created by the "Practice Weak
 * Areas" action, never by navigating to the URL.
 *
 * A refresh still passes: PracticeSessionService rehydrates its sessionStorage
 * snapshot on construction, so `hasSession()` is already true by the time the
 * guard runs. Direct or stale access redirects to Quiz Selection (`/quiz`, the
 * real Quiz Selection screen) rather than silently generating a session the user
 * did not ask for.
 *
 * A SUBMITTED session is sent forward to Results instead: pressing browser Back
 * from Results must not drop the user into a finished session they can no longer
 * answer.
 */
@Injectable({ providedIn: 'root' })
export class PracticeSessionGuard implements CanActivate {
  private readonly session = inject(PracticeSessionService);
  private readonly router = inject(Router);

  canActivate(): boolean | UrlTree {
    if (this.session.hasSession()) return true;
    if (this.session.hasResult()) return this.router.createUrlTree(['/practice/results']);
    return this.router.createUrlTree(['/quiz']);
  }
}
