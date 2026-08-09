import { Service, inject, signal, type Signal } from '@angular/core';
import { Observable, Subject, throwError } from 'rxjs';
import { catchError, map, tap } from 'rxjs/operators';

import { canonicalize } from './local-verdict.adapter';
import { TOPIC_QUIZ_VERDICT_ADAPTER } from './verdict-adapter';
import {
  IDLE_VERDICT_STATE,
  QuestionVerdictError,
  type QuestionCheckResult,
  type QuestionExpiredResult,
  type QuestionVerdictState,
  type TerminalVerdictArrival,
} from './question-verdict.types';

/**
 * The single correctness authority for Topic Quizzes.
 *
 * Today every consumer reads `option.correct` straight off the in-memory quiz
 * bank — 100-odd files across selection, highlighting, gating, FET, timers, dot
 * status, results and scoring. That is only possible because the whole answer
 * key is in the browser, which is precisely what the security migration is
 * removing.
 *
 * This service is the seam. Consumers ask IT whether an answer was right;
 * it answers from the local bank today and from
 * `POST /api/quizzes/:quizId/check` after the flip. Because the result types
 * already match the backend's response shape, that flip changes this file and
 * nothing else.
 *
 * ── Identity ───────────────────────────────────────────────────────
 *
 * A question is (quizId, exact questionText). An option is its exact text
 * within that question. No ids, no indexes, no opaque references — matching the
 * approved public contract, and audited as unambiguous across the whole bank.
 *
 * ── Asynchrony is deliberate ───────────────────────────────────────
 *
 * `checkAnswer` returns an Observable even though the local adapter is
 * synchronous. If it returned a plain value, every consumer would be written
 * against a synchronous API and would ALL have to change again when the answer
 * starts coming from the network. Paying that cost now keeps stage 10 to a
 * one-file change.
 *
 * ── No persistence ─────────────────────────────────────────────────
 *
 * Verdicts, correct-option sets and explanations are held in memory only and
 * are never written to localStorage or sessionStorage. Persisting them would
 * put the answer key back on disk — the exact problem being removed.
 */
@Service()
export class QuestionVerdictService {
  /**
   * Per-question state, keyed by `quizId` + canonical question text.
   *
   * A single signal holding an immutable map rather than one signal per
   * question: consumers read through `verdictFor()`, and a computed over one
   * source recomputes reliably. (Per-question signals created lazily would not
   * be tracked by a computed that ran before the question was first seen.)
   */
  private readonly _states = signal<ReadonlyMap<string, QuestionVerdictState>>(new Map());

  /** Where verdicts come from. Local bank today, `/check` after the cutover. */
  private readonly adapter = inject(TOPIC_QUIZ_VERDICT_ADAPTER);

  /**
   * Per-question request counter, for discarding STALE responses.
   *
   * A user clicking A, then A+B, then A+B+C produces three overlapping checks,
   * and nothing guarantees they come back in order. Without this, the first
   * response landing last would overwrite the newest verdict with the oldest
   * selection's — the UI would show a completed question as incomplete again,
   * or re-open one the user had finished.
   *
   * Every submission takes the next number for its question; a response applies
   * only while it still holds the latest. Cancellation is not enough on its own
   * because a response already in flight cannot be recalled.
   */
  private readonly generations = new Map<string, number>();

  /**
   * Separator for the composite state key.
   *
   * Written as an ESCAPE, not a literal control character: a raw NUL in source
   * makes the file binary to git and grep. NUL is used rather than a printable
   * character because it cannot occur in a quiz id or in question text, so no
   * combination of the two can collide with another.
   */
  private static readonly KEY_SEPARATOR = '\u0000';

  /** Composite key. Canonical text, so casing/whitespace cannot fork state. */
  private key(quizId: string, questionText: string): string {
    return `${quizId}${QuestionVerdictService.KEY_SEPARATOR}${canonicalize(questionText)}`;
  }

  /** Current state for one question. Never null — unseen questions read idle. */
  verdictFor(quizId: string, questionText: string): QuestionVerdictState {
    return this._states().get(this.key(quizId, questionText)) ?? IDLE_VERDICT_STATE;
  }

  /** Reactive handle for template/computed use. */
  readonly states: Signal<ReadonlyMap<string, QuestionVerdictState>> = this._states.asReadonly();

  private readonly _terminal = new Subject<TerminalVerdictArrival>();

  /**
   * Fires when a question reaches an AUTHORIZED terminal state.
   *
   * For UI that mutates on correctness rather than merely reading it. A computed
   * over `states` covers everything that re-derives during change detection; a
   * one-shot mutation (repainting bindings, greying the losers) needs an event,
   * and needs it at the moment authorization arrives rather than at the click
   * that requested it.
   *
   * An Observable rather than an effect deliberately: a service-level effect was
   * tried for the scoring equivalent and silently never scheduled in this
   * zoneless app.
   */
  readonly terminalVerdicts$: Observable<TerminalVerdictArrival> = this._terminal.asObservable();

  hasResolved(quizId: string, questionText: string): boolean {
    const phase = this.verdictFor(quizId, questionText).phase;
    return phase === 'resolved' || phase === 'expired';
  }

  /**
   * Was a SELECTED option correct?
   *
   * Returns null when the option was not selected, so a consumer cannot use
   * this to discover the correctness of something the user never picked while
   * the question is still incomplete. After resolution the full correct set is
   * available through the state, which is the authorized reveal.
   */
  verdictForOption(quizId: string, questionText: string, optionText: string): boolean | null {
    const state = this.verdictFor(quizId, questionText);
    return state.selectedVerdicts.get(canonicalize(optionText)) ?? null;
  }

  /**
   * Submit the CURRENT selection for one question.
   *
   * The full selection is sent every time rather than a delta: it makes the
   * call idempotent, it matches the backend contract, and it means a dropped
   * response cannot leave the server's view of the selection behind the
   * client's.
   */
  checkAnswer(
    quizId: string,
    questionText: string,
    selectedOptionTexts: readonly string[]
  ): Observable<QuestionCheckResult> {
    // SHAPE FIRST, before any state is touched. `markChecking` copies the
    // selection, and a non-array would throw a raw TypeError out of the spread
    // rather than the domain error — leaving the question stuck in `checking`
    // with no verdict ever arriving.
    if (!Array.isArray(selectedOptionTexts)) {
      return throwError(() => new QuestionVerdictError('Invalid submission'));
    }

    this.markChecking(quizId, questionText, selectedOptionTexts);
    const generation = this.nextGeneration(quizId, questionText);

    return this.adapter.check(quizId, questionText, selectedOptionTexts).pipe(
      tap((result) => {
        // A response that is no longer the latest is DROPPED, not applied. It
        // still reaches the subscriber — the caller asked for this specific
        // result — but it may not move shared state backwards.
        if (this.isCurrent(quizId, questionText, generation)) {
          this.applyResult(quizId, questionText, selectedOptionTexts, result);
        }
      }),
      catchError((err: unknown) => {
        // A stale FAILURE must not clobber a newer success either.
        if (this.isCurrent(quizId, questionText, generation)) {
          this.markError(quizId, questionText);
        }
        return throwError(() =>
          err instanceof QuestionVerdictError ? err : new QuestionVerdictError('Invalid submission')
        );
      })
    );
  }

  /** Claim the next request number for this question. */
  private nextGeneration(quizId: string, questionText: string): number {
    const key = this.key(quizId, questionText);
    const next = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, next);
    return next;
  }

  /** Is this response still the newest one issued for its question? */
  private isCurrent(quizId: string, questionText: string, generation: number): boolean {
    return this.generations.get(this.key(quizId, questionText)) === generation;
  }

  /**
   * Reveal a question because its timer expired.
   *
   * Local-only in this stage: the caller's timer decides. After the API flip
   * the signed receipt's deadline decides instead, and a client claim of expiry
   * is ignored entirely.
   */
  revealExpiredQuestion(quizId: string, questionText: string): Observable<QuestionExpiredResult> {
    // Expiry OUTRANKS any in-flight check: the deadline has passed, so a
    // selection response still on its way must not overwrite the reveal.
    const generation = this.nextGeneration(quizId, questionText);

    return this.adapter.revealExpired(quizId, questionText).pipe(
      map((result) => {
        if (this.isCurrent(quizId, questionText, generation)) {
          const existing = this.verdictFor(quizId, questionText);
          this.write(quizId, questionText, {
            ...existing,
            phase: 'expired',
            correctOptionTexts: result.correctOptionTexts,
            explanation: result.explanation,
            // Expiry reveals the answer; it does not claim the user got it right.
            isResolvedCorrect: existing.isResolvedCorrect,
          });
        }
        return result;
      }),
      catchError((err: unknown) => {
        if (this.isCurrent(quizId, questionText, generation)) {
          this.markError(quizId, questionText);
        }
        return throwError(() =>
          err instanceof QuestionVerdictError ? err : new QuestionVerdictError('Invalid submission')
        );
      })
    );
  }

  /**
   * Drop one question's verdict — e.g. a quiz restart.
   *
   * The generation counter is bumped rather than deleted: a check already in
   * flight must not be able to land afterwards and resurrect the state that was
   * just cleared. Deleting would reset the count to zero and let it match.
   */
  /**
   * Is any question's verdict still unresolved or failed?
   *
   * The finalization invariant: a quiz must not be scored while the answer to
   * "was this right?" is still in flight or has failed. Before the API cutover
   * that could not happen — the local adapter answers in the same tick — but
   * once `/check` is a round trip, finalizing early would mean scoring from a
   * superseded verdict, or falling back to the local answer key. Both are
   * exactly what this migration removes.
   *
   * `checking` blocks because the user's LATEST selection has not been judged.
   * `error` blocks because guessing is worse than making the user retry —
   * silently counting it wrong would be an invented score.
   *
   * `idle` does NOT block: a question the user never answered is a legitimate
   * final state (skipped, or timed out before any click), and nothing is
   * pending on it.
   *
   * Scoped to one quiz when `quizId` is given, since state survives across a
   * session and another quiz's leftovers must not block this one.
   */
  hasBlockingVerdicts(quizId?: string): boolean {
    const prefix = quizId
      ? `${quizId}${QuestionVerdictService.KEY_SEPARATOR}`
      : null;

    for (const [key, state] of this._states()) {
      if (prefix !== null && !key.startsWith(prefix)) continue;
      if (state.phase === 'checking' || state.phase === 'error') return true;
    }
    return false;
  }

  clearQuestion(quizId: string, questionText: string): void {
    this.nextGeneration(quizId, questionText);
    const next = new Map(this._states());
    next.delete(this.key(quizId, questionText));
    this._states.set(next);
  }

  /** Drop everything. In-memory only, so nothing else needs cleaning up. */
  clearAll(): void {
    // Same reasoning as clearQuestion: bump every counter so no in-flight
    // response can apply against the cleared state.
    for (const key of [...this.generations.keys()]) {
      this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    }
    this._states.set(new Map());
  }

  // ── internals ────────────────────────────────────────────────────

  private write(quizId: string, questionText: string, state: QuestionVerdictState): void {
    const next = new Map(this._states());
    next.set(this.key(quizId, questionText), state);
    this._states.set(next);

    // ARRIVAL. Correctness-dependent UI cannot run on the click that requests a
    // check — under the API adapter the phase is still `checking` then, so a
    // consumer painting at click time has nothing authorized to paint from and
    // ends up reading the local bank. This announces the moment authorization
    // actually exists.
    //
    // ONLY terminal phases are announced, because only they carry the full
    // correct set. `markChecking` and `markError` write non-terminal phases, so
    // they cannot reach this. And every terminal write already sits inside an
    // `isCurrent()` guard, so a stale response is dropped BEFORE it can be
    // announced — subscribers inherit the generation protection instead of
    // re-implementing it.
    if (state.phase === 'resolved' || state.phase === 'expired') {
      this._terminal.next({ quizId, questionText, state });
    }
  }

  private markChecking(
    quizId: string,
    questionText: string,
    selectedOptionTexts: readonly string[]
  ): void {
    // The optimistic phase: the selection is shown immediately while the
    // verdict is pending, and navigation stays blocked until it lands. Local
    // evaluation resolves in the same tick, but the phase exists so consumers
    // are already written for the asynchronous case.
    this.write(quizId, questionText, {
      ...this.verdictFor(quizId, questionText),
      phase: 'checking',
      selectedOptionTexts: [...selectedOptionTexts],
    });
  }

  private markError(quizId: string, questionText: string): void {
    // The LAST CONFIRMED state is kept; only the phase changes. A failed check
    // must never be displayed as though it were a recorded answer.
    this.write(quizId, questionText, {
      ...this.verdictFor(quizId, questionText),
      phase: 'error',
    });
  }

  private applyResult(
    quizId: string,
    questionText: string,
    selectedOptionTexts: readonly string[],
    result: QuestionCheckResult
  ): void {
    const selected = [...selectedOptionTexts];

    if (result.status === 'incomplete') {
      this.write(quizId, questionText, {
        phase: 'incomplete',
        selectedOptionTexts: selected,
        selectedVerdicts: new Map(
          result.selectedVerdicts.map((verdict) => [canonicalize(verdict.text), verdict.correct])
        ),
        remainingCorrectCount: result.remainingCorrectCount,
        // Nothing revealed yet.
        correctOptionTexts: [],
        explanation: null,
        isResolvedCorrect: null,
      });
      return;
    }

    if (result.status === 'resolved') {
      this.write(quizId, questionText, {
        phase: 'resolved',
        selectedOptionTexts: selected,
        selectedVerdicts: new Map(
          selected.map((text) => [
            canonicalize(text),
            result.correctOptionTexts.some(
              (correct) => canonicalize(correct) === canonicalize(text)
            ),
          ])
        ),
        remainingCorrectCount: 0,
        correctOptionTexts: result.correctOptionTexts,
        explanation: result.explanation,
        isResolvedCorrect: result.correct,
      });
      return;
    }

    this.write(quizId, questionText, {
      ...this.verdictFor(quizId, questionText),
      phase: 'expired',
      selectedOptionTexts: selected,
      correctOptionTexts: result.correctOptionTexts,
      explanation: result.explanation,
    });
  }
}
