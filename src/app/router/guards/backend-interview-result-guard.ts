import { inject, Injectable } from '@angular/core';
import { ActivatedRouteSnapshot, CanActivate, Router, UrlTree } from '@angular/router';

import { BackendInterviewResultService } from '@shared/services/interview/backend-interview-result.service';

/**
 * Guards `/interview/results/:sessionId`.
 *
 * Uses the SAME loading pipeline as the Results page, so activating the route
 * costs exactly one `GET /result`: the guard loads, the component renders what
 * the service now holds.
 *
 * Outcomes:
 *   loaded        allow
 *   not-ready     → back to the live session (it is still running)
 *   unavailable   ALLOW — the page shows a retryable state; the reference is
 *                 kept so an outage cannot lock the user out of a finished
 *                 assessment
 *   malformed     ALLOW — the page shows a safe error rather than a blank
 *   unauthorized  → builder (the invalid v2 reference has been cleared)
 *   none          → builder
 */
@Injectable({ providedIn: 'root' })
export class BackendInterviewResultGuard implements CanActivate {
  private readonly results = inject(BackendInterviewResultService);
  private readonly router = inject(Router);

  async canActivate(route: ActivatedRouteSnapshot): Promise<boolean | UrlTree> {
    const sessionId = route.paramMap.get('sessionId') ?? '';
    if (!sessionId) return this.toBuilder();

    const outcome = await this.results.load(sessionId);

    switch (outcome.kind) {
      case 'loaded':
      case 'unavailable':
      case 'malformed':
        return true;
      case 'not-ready':
        // The assessment has not been submitted — send the user back to it
        // rather than showing an empty results page.
        return this.router.createUrlTree(['/interview/session', sessionId]);
      case 'unauthorized':
      case 'none':
      default:
        return this.toBuilder();
    }
  }

  private toBuilder(): UrlTree {
    return this.router.createUrlTree(['/interview']);
  }
}
