import { Service, inject } from '@angular/core';
import {
  ActivatedRouteSnapshot, Resolve, Router, RouterStateSnapshot, UrlTree
} from '@angular/router';
import { Observable, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';

import { Quiz, QuizDifficulty } from '../../models/Quiz.model';

import { QuizService } from '../data/quiz.service';
import { TopicQuizMetadataService } from '../api/topic-quiz-metadata.service';

/**
 * S6f: identity/existence only, from the safe metadata endpoint — never the
 * bundled answer-bearing bank. `questions` is always `[]`; real question
 * content already comes from a separate, already-established API path
 * (`QuizDataService.getQuestionsForQuiz`/`fetchQuizQuestions`), never from
 * this resolved object. The router BLOCKS navigation until this Observable
 * emits, so switching the async source (bank HTTP -> metadata HTTP) carries
 * the same safety property the old bank-backed resolve() already had — no
 * new race is introduced.
 */
@Service()
export class QuizResolverService implements Resolve<Quiz | UrlTree | null> {
  // ── injects ─────────────────────────────────────────────────────
  private quizService = inject(QuizService);
  private metadataApi = inject(TopicQuizMetadataService);
  private router = inject(Router);

  // ── public methods ──────────────────────────────────────────────
  resolve(
    route: ActivatedRouteSnapshot,
    _state: RouterStateSnapshot,
  ): Observable<Quiz | UrlTree | null> {
    const quizId = route.params['quizId'];

    // Fast Path: If we already have the quiz loaded, don't re-fetch.
    // This prevents "cold observable" stutter or "waiting for data" hangs during Q1->Q2 nav.
    const activeQuiz = this.quizService.selectedQuiz;
    if (activeQuiz && activeQuiz.quizId === quizId) return of(activeQuiz);

    return this.metadataApi.load().pipe(
      map((entries) => entries.find((e) => e.quizId === quizId)),
      map((entry) => {
        if (!entry) {
          return this.router.createUrlTree(['/quiz']);
        }
        const quiz: Quiz = {
          quizId: entry.quizId,
          milestone: entry.milestone ?? quizId,
          summary: '',
          image: entry.image ?? '',
          difficulty: (entry.difficulty ?? undefined) as QuizDifficulty | undefined,
          facts: entry.facts ? [...entry.facts] : [],
          questions: []
        };
        return quiz;
      }),
      catchError(() => {
        return of(this.router.createUrlTree(['/quiz']));
      })
    );
  }
}