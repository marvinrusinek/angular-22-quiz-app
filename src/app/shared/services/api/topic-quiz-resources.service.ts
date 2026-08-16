import { Service, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';

import { API_BASE_URL } from '../../tokens/api-base-url.token';
import type { Resource } from '../../models/Resource.model';

/**
 * The Results-page "Brush up your knowledge" links, from the private API.
 *
 * ── Why this exists ────────────────────────────────────────────────
 *
 * These links were the last piece of `assets/data/quiz.json` with no source
 * anywhere else — they live in a top-level `resources` block in that file, so
 * the quiz-bank migration did not carry them, and they blocked removing the
 * public asset in both the Angular and backend stages. They now come from
 * `GET /api/quizzes/:quizId/resources`, served from PostgreSQL.
 *
 * ── Why this one does NOT fail closed ──────────────────────────────
 *
 * `TopicQuizQuestionsService` throws on failure, deliberately: questions the
 * client cannot load mean there is no quiz to play. Resources are supplemental
 * — an optional panel on a results page — so a failed load must not take the
 * results screen with it. It resolves to an EMPTY LIST instead.
 *
 * Empty is not a fallback. There is no read of the local bank here, by any
 * path: the panel simply has nothing to show, exactly as it already does for
 * the twelve quizzes that have no links at all. Pinned by
 * `topic-quiz-resources.service.spec.ts`.
 */

interface QuizResourceDto {
  readonly title: string;
  readonly url: string;
  readonly host: string;
}

interface QuizResourcesBody {
  readonly quizId: string;
  readonly resources: readonly QuizResourceDto[];
}

@Service()
export class TopicQuizResourcesService {
  private readonly http = inject(HttpClient);
  private readonly apiBaseUrl = inject(API_BASE_URL);

  /**
   * Load one quiz's resource links, in display order.
   *
   * Never errors. An unknown quiz, an unreachable API and a malformed body all
   * resolve to `[]`.
   */
  loadResources(quizId: string): Observable<Resource[]> {
    if (!quizId) return of([]);

    const url = `${this.apiBaseUrl}/quizzes/${encodeURIComponent(quizId)}/resources`;

    return this.http.get<QuizResourcesBody>(url).pipe(
      map((body) => this.toResources(body)),
      catchError(() => of([]))
    );
  }

  /**
   * Map the response, dropping anything malformed.
   *
   * Named field by field rather than spread, matching the questions service: a
   * field the server later added would not reach a consumer. Server order is
   * preserved — the endpoint sorts by `display_order` and nothing re-sorts here.
   */
  private toResources(body: QuizResourcesBody): Resource[] {
    if (!body || !Array.isArray(body.resources)) return [];

    const out: Resource[] = [];
    for (const resource of body.resources) {
      if (!resource || typeof resource.title !== 'string' || !resource.title) continue;
      if (typeof resource.url !== 'string' || !resource.url) continue;
      out.push({
        title: resource.title,
        url: resource.url,
        host: typeof resource.host === 'string' ? resource.host : ''
      });
    }
    return out;
  }
}
