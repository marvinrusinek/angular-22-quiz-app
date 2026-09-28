import { inject, Service } from '@angular/core';
import {
  ActivatedRouteSnapshot,
  CanActivate,
  Router,
  RouterStateSnapshot,
  UrlTree,
} from '@angular/router';
import { Observable, of } from 'rxjs';
import { map } from 'rxjs/operators';

import { TopicQuizMetadataService } from '@shared/services/api/topic-quiz-metadata.service';
import { QuizService } from '@shared/services/data/quiz.service';
import { QuizProgressionService } from '@shared/services/flow/quiz-progression.service';

/**
 * S6h: index validation only, from the same API-backed metadata source the
 * resolver already uses (TopicQuizMetadataService) — never the bundled
 * answer-bearing bank. `load()` is shared/cached ("at most once per page
 * life"), so calling it here alongside the resolver's own call costs no
 * extra request and introduces no race.
 *
 * Existence validation stays the resolver's job: a quizId absent from the
 * metadata map is treated as "unknown to this guard" and passed through
 * (`true`) exactly as an uncached quiz used to be — the resolver redirects
 * unknown quizzes on its own (see quiz-resolver.service.ts, S6f).
 *
 * PROGRESSION validation is the second, independent check added here: even
 * an in-range index can be a direct-route bypass (typed, pasted, or replayed
 * from history) of a question the current attempt has not legitimately
 * reached yet. `QuizProgressionService` is the one source of truth for how
 * far the attempt has gotten; see its own doc comment for why a verdict alone
 * cannot answer that. Both checks are synchronous (sessionStorage-backed), so
 * this adds no latency and no new async dependency.
 */
@Service()
export class QuizGuard implements CanActivate {
  private readonly metadataApi = inject(TopicQuizMetadataService);
  private readonly quizService = inject(QuizService);
  private readonly progressionService = inject(QuizProgressionService);
  private readonly router = inject(Router);

  canActivate(
    route: ActivatedRouteSnapshot,
    _state: RouterStateSnapshot
  ): Observable<boolean | UrlTree> {
    const quizId = route.params['quizId'];
    const questionParam = route.params['questionIndex'];

    if (!quizId) return of(this.router.createUrlTree(['/quiz']));

    const normalized = this.normalizeQuestionIndex(questionParam, quizId);
    if (normalized instanceof UrlTree) return of(normalized);

    return this.metadataApi.load().pipe(
      map(() => {
        const knownCount = this.metadataApi.questionCountByQuiz().get(quizId);
        if (!knownCount) return true; // unknown to metadata, or no count reported — let resolver load/redirect
        return this.evaluateQuestionRequest(knownCount, normalized, quizId);
      })
    );
  }

  private normalizeQuestionIndex(questionParam: unknown, quizId: string): number | UrlTree {
    if (questionParam == null) {
      return this.router.createUrlTree(['/quiz/question', quizId, 1]);
    }

    const parsed = Number.parseInt(String(questionParam).trim(), 10);
    if (!Number.isFinite(parsed)) {
      return this.router.createUrlTree(['/quiz/intro', quizId]);
    }

    if (parsed < 1) {
      return this.router.createUrlTree(['/quiz/question', quizId, 1]);
    }

    return parsed;
  }

  private evaluateQuestionRequest(
    metadataCount: number,
    questionIndex: number,
    quizId: string
  ): boolean | UrlTree {
    // Use the maximum known count from all sources to avoid false-negative blocks
    const serviceQuestionsCount = this.quizService.questions?.length ?? 0;
    const total = Math.max(metadataCount, serviceQuestionsCount, 1);

    if (total <= 0) return this.router.createUrlTree(['/quiz']);

    const zeroIdx = questionIndex - 1;
    if (zeroIdx < 0 || zeroIdx >= total) {
      const fallback = Math.min(total, Math.max(1, questionIndex));
      if (fallback !== questionIndex) {
        return this.router.createUrlTree(['/quiz/question', quizId, fallback]);
      }
      return this.router.createUrlTree(['/quiz/intro', quizId]);
    }

    // IN RANGE is not the same as LEGITIMATELY REACHED. A locked future
    // question redirects to the furthest one this attempt has actually
    // earned — never rendered, even briefly, before the redirect (returning
    // a UrlTree here, rather than navigating imperatively, means the router
    // never activates this route at all).
    const furthest = this.progressionService.getFurthestUnlocked(quizId, total);
    if (questionIndex > furthest) {
      return this.router.createUrlTree(['/quiz/question', quizId, furthest]);
    }

    return true;
  }
}
