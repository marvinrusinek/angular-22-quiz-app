import { inject, Service } from '@angular/core';
import { ActivatedRouteSnapshot, CanActivate, Router, UrlTree } from '@angular/router';

import { QuizService } from '@shared/services/data/quiz.service';

/**
 * Protects Topic Quiz Results (`quiz/results/:quizId`). A direct or stale
 * navigation to this route — a different quiz than the one actually
 * completed, or no completed attempt at all — must not render or record a
 * result for that quizId; see `QuizService.hasValidResultFor` for exactly
 * what counts as a legitimate completed result.
 *
 * An invalid request never activates the route (returns a UrlTree instead of
 * navigating imperatively), so ResultsComponent never mounts for it at all.
 */
@Service()
export class QuizResultGuard implements CanActivate {
  private readonly quizService = inject(QuizService);
  private readonly router = inject(Router);

  canActivate(route: ActivatedRouteSnapshot): boolean | UrlTree {
    const quizId = route.paramMap.get('quizId') ?? '';
    if (!quizId) return this.router.createUrlTree(['/quiz']);

    if (this.quizService.hasValidResultFor(quizId)) return true;

    // No valid completed attempt for THIS quiz — send the user somewhere
    // safe and sensible for it, never Quiz Selection's generic redirect
    // (which would discard the quizId the URL was actually asking about).
    return this.router.createUrlTree(['/quiz/intro', quizId]);
  }
}
