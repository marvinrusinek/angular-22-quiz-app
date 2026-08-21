import { Service, inject, signal, type Signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { catchError, map, shareReplay, tap } from 'rxjs/operators';

import { API_BASE_URL } from '../../tokens/api-base-url.token';

/**
 * PUBLIC quiz metadata from `GET /api/quizzes`.
 *
 * ── What belongs here, and what does not ───────────────────────────
 *
 * The contracts stay separated, and this service is the metadata half:
 *
 *   /quizzes    metadata — facts, image, counts, difficulty   ← THIS
 *   /questions  question content, declared type, correctCount
 *   /resources  the Results-page "Brush up" links
 *   /check      correctness and explanations
 *
 * It carries no questions, no options, no correctness and no explanations, and
 * the server's PUBLIC_METADATA response policy independently enforces that.
 *
 * ── Facts were stranded ────────────────────────────────────────────
 *
 * `facts` reached PostgreSQL but never reached the client: `normalizeQuiz`
 * dropped the field on the way into the private model, so `QuizMetadata` never
 * carried it and `QuizMetadataDto` could not serve it. The Results page read
 * them from `assets/data/quiz.json` instead — one of the last runtime
 * dependencies on that asset.
 *
 * ── Why this does NOT fail closed ──────────────────────────────────
 *
 * Same reasoning as `TopicQuizResourcesService`: questions the client cannot
 * load mean there is no quiz to play, so that service throws. Facts are
 * supplemental trivia on a results screen, so a failed load must not take the
 * page with it — it resolves to NOTHING, exactly as it already does for the
 * quizzes that have no facts at all.
 *
 * Empty is not a fallback. There is no read of the local bank here by any path.
 */

interface QuizMetadataEntryDto {
  readonly quizId: string;
  readonly milestone?: string;
  readonly image?: string;
  readonly difficulty?: string | null;
  readonly facts?: readonly string[];
  readonly questionCount?: number;
}

interface QuizMetadataListBody {
  readonly quizzes: readonly QuizMetadataEntryDto[];
}

@Service()
export class TopicQuizMetadataService {
  private readonly http = inject(HttpClient);
  private readonly apiBaseUrl = inject(API_BASE_URL);

  /** quizId → facts, for the metadata the server has returned so far. */
  private readonly _factsByQuiz = signal<ReadonlyMap<string, readonly string[]>>(new Map());

  /** Read by consumers through `factsFor`; exposed so a computed can track it. */
  readonly factsByQuiz: Signal<ReadonlyMap<string, readonly string[]>> =
    this._factsByQuiz.asReadonly();

  /** quizId → tile/intro image URL, from the same metadata response. */
  private readonly _imageByQuiz = signal<ReadonlyMap<string, string>>(new Map());

  /** Exposed so a template-facing computed can track it. */
  readonly imageByQuiz: Signal<ReadonlyMap<string, string>> = this._imageByQuiz.asReadonly();

  /** One in-flight request shared by every caller. */
  private inFlight: Observable<readonly QuizMetadataEntryDto[]> | null = null;

  /**
   * Load the metadata list, at most once per page life.
   *
   * Never rejects: a failure leaves the map empty and callers render nothing.
   */
  load(): Observable<readonly QuizMetadataEntryDto[]> {
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.http
      .get<QuizMetadataListBody>(`${this.apiBaseUrl}/quizzes`)
      .pipe(
        map((body) => body?.quizzes ?? []),
        tap((entries) => {
          const facts = new Map<string, readonly string[]>();
          const images = new Map<string, string>();
          for (const entry of entries) {
            if (!entry?.quizId) continue;
            facts.set(
              entry.quizId,
              Array.isArray(entry.facts)
                ? entry.facts.filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
                : []
            );
            if (typeof entry.image === 'string' && entry.image.trim().length > 0) {
              images.set(entry.quizId, entry.image.trim());
            }
          }
          this._factsByQuiz.set(facts);
          this._imageByQuiz.set(images);
        }),
        catchError(() => of([] as readonly QuizMetadataEntryDto[])),
        shareReplay({ bufferSize: 1, refCount: false })
      );

    return this.inFlight;
  }

  /**
   * The facts for one quiz, or an empty list.
   *
   * Empty means "the server has not given us any" — never a reason to consult
   * the local bank.
   */
  factsFor(quizId: string | null | undefined): readonly string[] {
    if (!quizId) return [];
    return this._factsByQuiz().get(quizId) ?? [];
  }

  /**
   * The tile / intro image for one quiz, or '' when the server has not said.
   *
   * Consumers treat '' as "fall back to the bundled value FOR NOW". That
   * fallback is transitional and exists for one reason: the metadata call can
   * be slow on a cold backend, and a bundled image renders instantly, so
   * API-only would leave every tile blank for as long as the cold start takes.
   * Because both sources carry the identical URLs today, API-first is invisible
   * when it lands and harmless when it does not.
   *
   * REMOVE THE FALLBACK WITH THE ASSET (S7b-2), at which point '' simply means
   * no background — the same degraded state `safeImageUrl` already produces for
   * a value it rejects.
   */
  imageFor(quizId: string | null | undefined): string {
    if (!quizId) return '';
    return this._imageByQuiz().get(quizId) ?? '';
  }
}
