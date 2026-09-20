import { inject, Injectable } from '@angular/core';
import { ActivatedRouteSnapshot, CanActivate, Router, UrlTree } from '@angular/router';

import { BackendInterviewResultService } from '../../shared/services/interview/backend-interview-result.service';
import { BackendInterviewSessionService } from '../../shared/services/interview/backend-interview-session.service';
import { InterviewSessionReferenceStorage } from '../../shared/services/interview/interview-session-reference.storage';

/**
 * THE single hydration pipeline for `/interview/session/:sessionId`.
 *
 * Resume happens here and nowhere else — the component reads already-hydrated
 * state, so there is exactly one HTTP call per navigation.
 *
 * Outcomes:
 *   active        allow
 *   none          no stored reference        → builder
 *   mismatch      route id ≠ stored id       → builder (reference kept: it may
 *                                              belong to a different, valid tab)
 *   unauthorized  reference already cleared  → builder
 *   submitted     the resume call only CLAIMS this (409 CONFLICT), and
 *   expired       (409 SESSION_EXPIRED) is a session past its deadline that
 *                 nothing has finalized yet. Neither is taken on trust: the
 *                 authenticated result endpoint confirms (and, for an expired
 *                 session, finalizes) it. Confirmed → results. Dead credential
 *                 → builder. Anything it cannot confirm → ALLOW, and the
 *                 component shows its retry card. Never a redirect on a guess,
 *                 so a stray 409 cannot ping-pong with the Results guard.
 *   unavailable   ALLOW — the component shows a retry state; the reference is
 *                 deliberately preserved so a transient outage cannot destroy a
 *                 live assessment
 */
@Injectable({ providedIn: 'root' })
export class BackendInterviewSessionGuard implements CanActivate {
  private readonly session = inject(BackendInterviewSessionService);
  private readonly results = inject(BackendInterviewResultService);
  private readonly storage = inject(InterviewSessionReferenceStorage);
  private readonly router = inject(Router);

  async canActivate(route: ActivatedRouteSnapshot): Promise<boolean | UrlTree> {
    const routeSessionId = route.paramMap.get('sessionId') ?? '';
    const reference = this.storage.read();

    if (!reference) return this.toBuilder();

    // A route id that does not match the stored reference is not authorized by
    // it. The reference is left intact rather than destroyed on the strength of
    // a URL someone may have typed.
    if (routeSessionId !== reference.sessionId) return this.toBuilder();

    const outcome = await this.session.resumeFromStoredReference();

    switch (outcome.kind) {
      case 'active':
      case 'unavailable':
        return true;
      case 'submitted':
      case 'expired': {
        const verdict = await this.results.confirmFinished();
        if (verdict.kind === 'results') {
          return this.router.createUrlTree(['/interview/results', verdict.sessionId]);
        }
        if (verdict.kind === 'builder') return this.toBuilder();
        return true;   // unresolved: the component renders the retry card
      }
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
