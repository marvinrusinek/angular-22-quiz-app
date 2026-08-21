import { Service, inject, signal, type Signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError, map, tap } from 'rxjs/operators';

import { API_BASE_URL } from '../../../tokens/api-base-url.token';
import { TopicQuizAttemptService } from '../verdict/topic-quiz-attempt.service';
import {
  QuestionVerdictError,
  type QuestionCheckResult
} from '../verdict/question-verdict.types';

/**
 * The correctness authority for Weak Areas Practice.
 *
 * ── Not a second scorer ────────────────────────────────────────────
 *
 * Nothing here decides whether an answer is right. It posts the user's
 * selection to the SAME `POST /api/quizzes/:quizId/check` the Topic Quiz uses
 * and records what the server said. Grading lives in the backend's
 * `checkAnswer`, and exists once.
 *
 * This is a separate service from `QuestionVerdictService` for exactly one
 * reason, and it is not a stylistic one: the two differ in how the per-question
 * receipt is obtained. A Topic Quiz question is TIMED and must keep its
 * original receipt so navigating away cannot restart its countdown. A practice
 * question is UNTIMED and needs a fresh receipt per check — otherwise thinking
 * for more than thirty seconds returns `expired`, which reveals the answer and
 * never grades it.
 *
 * ── Identity ───────────────────────────────────────────────────────
 *
 * A practice question is `(sourceQuizId, exact questionText)`, the same
 * text-based identity the endpoint uses. Practice mixes questions from several
 * quizzes, so the quiz id travels with every call rather than being ambient.
 *
 * ── No local fallback, ever ────────────────────────────────────────
 *
 * A failed check produces an ERROR verdict. It does not fall back to the local
 * bank's `option.correct`: that is the dependency this slice removes, and a
 * fallback would work in development and fail silently the day the bank goes.
 *
 * ── Memory only ────────────────────────────────────────────────────
 *
 * Verdicts, revealed options and explanations are never persisted. The session
 * persists the user's SELECTIONS so a refresh resumes; persisting what the
 * server revealed would put the answer key back on disk.
 */

/** What practice knows about one question once the server has answered. */
export interface PracticeVerdict {
  /** Terminal AND fully right — drives reveal, lock and score. */
  readonly resolved: boolean;
  /** Terminal in the server's sense: no further selection can change it. */
  readonly terminal: boolean;
  /** The server's verdict for options the USER picked. Never unpicked ones. */
  readonly selectedVerdicts: ReadonlyMap<string, boolean>;
  /** Correct option texts, released by the server only once terminal. */
  readonly correctTexts: readonly string[];
  /** How many correct options remain unpicked, when the server said so. */
  readonly remainingCorrectCount: number | null;
  /** The explanation the server released with the reveal. Empty until then. */
  readonly explanation: string;
  /** The check failed. Distinct from "answered wrongly". */
  readonly errored: boolean;
}

const EMPTY_VERDICT: PracticeVerdict = {
  resolved: false,
  terminal: false,
  selectedVerdicts: new Map<string, boolean>(),
  correctTexts: [],
  remainingCorrectCount: null,
  explanation: '',
  errored: false
};

/** Matches the server's canonicalization closely enough to key by text. */
function canonical(text: string | null | undefined): string {
  return (text ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

@Service()
export class PracticeVerdictService {
  private readonly http = inject(HttpClient);
  private readonly apiBaseUrl = inject(API_BASE_URL);
  private readonly attempts = inject(TopicQuizAttemptService);

  private readonly _verdicts = signal<ReadonlyMap<string, PracticeVerdict>>(
    new Map<string, PracticeVerdict>()
  );

  /** Every verdict held, so a component can derive through one computed. */
  readonly verdicts: Signal<ReadonlyMap<string, PracticeVerdict>> = this._verdicts.asReadonly();

  private key(quizId: string, questionText: string): string {
    return `${quizId}::${canonical(questionText)}`;
  }

  /** The verdict for one question, or the neutral empty one. */
  verdictFor(quizId: string, questionText: string): PracticeVerdict {
    return this._verdicts().get(this.key(quizId, questionText)) ?? EMPTY_VERDICT;
  }

  /**
   * Is this option KNOWN wrong?
   *
   * True only for an option the user actually picked and the server called
   * wrong. Absence of knowledge is never "wrong": an option nobody has asked
   * about returns false, which is what keeps an unanswered question neutral.
   */
  isKnownIncorrect(quizId: string, questionText: string, optionText: string): boolean {
    return this.verdictFor(quizId, questionText).selectedVerdicts.get(canonical(optionText)) === false;
  }

  /** Is this option revealed CORRECT? Only ever true once resolved. */
  isRevealedCorrect(quizId: string, questionText: string, optionText: string): boolean {
    const verdict = this.verdictFor(quizId, questionText);
    if (!verdict.resolved) return false;
    return verdict.correctTexts.some((text) => canonical(text) === canonical(optionText));
  }

  /** Fully, exactly right — the reveal / lock / score condition. */
  isResolved(quizId: string, questionText: string): boolean {
    return this.verdictFor(quizId, questionText).resolved;
  }

  /**
   * Submit the current selection for one practice question.
   *
   * The receipt is obtained fresh immediately before the request, so a question
   * that sat unanswered for minutes is still graded on its merits.
   */
  check(
    quizId: string,
    questionText: string,
    selectedOptionTexts: readonly string[]
  ): Observable<QuestionCheckResult> {
    if (!Array.isArray(selectedOptionTexts)) {
      return throwError(() => new QuestionVerdictError('Invalid submission'));
    }

    const url = `${this.apiBaseUrl}/quizzes/${encodeURIComponent(quizId)}/check`;

    return this.attempts
      .withFreshUntimedPracticeReceipt(quizId, questionText, (headers) =>
        this.http.post<QuestionCheckResult>(
          url,
          { questionText, selectedOptionTexts: [...selectedOptionTexts] },
          { headers }
        )
      )
      .pipe(
        map((result) => {
          if (!result || typeof (result as { status?: unknown }).status !== 'string') {
            throw new QuestionVerdictError('Invalid submission');
          }
          return result;
        }),
        tap((result) => this.apply(quizId, questionText, result)),
        catchError((err: unknown) => {
          this.markErrored(quizId, questionText);
          return throwError(() =>
            err instanceof QuestionVerdictError ? err : new QuestionVerdictError('Invalid submission')
          );
        })
      );
  }

  /** Translate one server outcome into the verdict practice reads. */
  private apply(quizId: string, questionText: string, result: QuestionCheckResult): void {
    const outcome = result as unknown as {
      status: string;
      correct?: boolean;
      correctOptions?: readonly unknown[];
      selectedVerdicts?: readonly { text?: unknown; correct?: unknown }[];
      remainingCorrectCount?: unknown;
      explanation?: unknown;
    };

    const selectedVerdicts = new Map<string, boolean>();
    for (const entry of outcome.selectedVerdicts ?? []) {
      if (entry && typeof entry.text === 'string') {
        selectedVerdicts.set(canonical(entry.text), entry.correct === true);
      }
    }

    const correctTexts = (outcome.correctOptions ?? [])
      .map((option) =>
        typeof option === 'string' ? option : ((option as { text?: unknown })?.text as string) ?? ''
      )
      .filter((text): text is string => typeof text === 'string' && text.length > 0);

    const terminal = outcome.status === 'resolved' || outcome.status === 'expired';

    // `resolved` is terminal AND right. A single-answer question answered
    // wrongly is terminal too, and must NOT count as resolved or be scored.
    const resolved = outcome.status === 'resolved' && outcome.correct !== false;

    // Once the server has revealed the correct set, any picked option outside it
    // is known wrong. This is what paints a wrong single-answer pick, for which
    // the server sends no `selectedVerdicts` array.
    if (terminal && correctTexts.length > 0) {
      const correctKeys = new Set(correctTexts.map((text) => canonical(text)));
      for (const text of selectedVerdicts.keys()) {
        selectedVerdicts.set(text, correctKeys.has(text));
      }
    }

    this.write(quizId, questionText, {
      resolved,
      terminal,
      selectedVerdicts,
      correctTexts,
      remainingCorrectCount:
        typeof outcome.remainingCorrectCount === 'number' ? outcome.remainingCorrectCount : null,
      explanation: typeof outcome.explanation === 'string' ? outcome.explanation : '',
      errored: false
    });
  }

  /**
   * Record that the check failed, WITHOUT inventing correctness.
   *
   * The previous verdict is kept so a transient failure does not erase a
   * verdict the server already gave.
   */
  private markErrored(quizId: string, questionText: string): void {
    this.write(quizId, questionText, { ...this.verdictFor(quizId, questionText), errored: true });
  }

  private write(quizId: string, questionText: string, verdict: PracticeVerdict): void {
    const next = new Map(this._verdicts());
    next.set(this.key(quizId, questionText), verdict);
    this._verdicts.set(next);
  }

  /**
   * Seed a verdict directly. TEST SEAM AND SESSION RESTORE ONLY.
   *
   * Never a way to assert correctness from the client: callers pass what the
   * server already said. It exists so a restored session can re-present
   * verdicts held in memory for the current page life.
   */
  seed(quizId: string, questionText: string, verdict: PracticeVerdict): void {
    this.write(quizId, questionText, verdict);
  }

  /** Starting a new session forgets every verdict and practice credential. */
  clear(): void {
    this._verdicts.set(new Map<string, PracticeVerdict>());
    this.attempts.clearUntimedPracticeReceipts();
  }
}
