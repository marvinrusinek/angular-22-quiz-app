import { Service, inject } from '@angular/core';

import { QuizService } from '@shared/services/data/quiz.service';
import { SK_FURTHEST_UNLOCKED } from '@shared/constants/session-keys';
import { swallow } from '@shared/utils/error-logging';

/**
 * THE single source of truth for "how far into this quiz attempt has the
 * user legitimately progressed" — closes the direct-route bypass:
 * `QuizGuard` previously validated only that a requested index was IN RANGE,
 * never whether the user had actually earned it, so typing/pasting a future
 * question's URL (or its number in the address bar) skipped straight to it.
 *
 * Deliberately separate from `QuestionVerdictService`: a verdict is a
 * per-question fact ("was THIS question's answer correct") and cannot express
 * a SEQUENCE fact ("has every question up to N been legitimately passed") —
 * a single resolved-correct verdict for question 5 says nothing about
 * whether 2, 3 and 4 were ever reached. This service tracks that sequence
 * fact directly, as one small, explicit number.
 *
 * ── Attempt scoping ─────────────────────────────────────────────────
 *
 * Bound to (quizId, attemptId, schema version). `attemptId` is
 * `QuizService`'s existing `startNewAttempt()`/`getCurrentAttemptId()` —
 * already minted fresh on every new quiz start and on the in-quiz Restart
 * button, exactly the identity a "new attempt begins at question 1" rule
 * needs. A record whose quizId or attemptId does not match the CURRENT one is
 * worthless and is never read back — the fail-closed default is 1, not the
 * previous attempt's progress. The Results-page Restart path does not mint a
 * new attemptId (a separate, hand-rolled reset sequence), so it calls
 * `clear()` here explicitly instead of relying on attemptId mismatch alone.
 *
 * ── Lazy attempt creation (direct/bookmarked entry to question 1) ────
 *
 * `startNewAttempt()` has exactly two production call sites:
 * `IntroductionComponent`'s Start button and the in-quiz Restart confirm
 * handler. A session that reaches `/quiz/question/:quizId/1` any OTHER way —
 * a bookmark, a shared link, browser history, a hand-typed URL — is a
 * perfectly legitimate entry (question 1 is always allowed), but arrives with
 * NO attemptId. Answering correctly and clicking Next used to be silently
 * inert for such a session: `unlockThrough` had nothing to attribute a write
 * to, so it no-opped, and the guard redirected every subsequent Next straight
 * back to question 1 forever — a genuine progression regression, not a test
 * artifact (found via 27 legacy E2E failures that all shared this exact
 * shape).
 *
 * `unlockThrough` now mints an attempt itself, but ONLY from within an
 * already-approved forward-progression call — never from `getFurthestUnlocked`
 * (a pure read, called by the guard on every URL evaluation) and never merely
 * because a future URL was requested. A lazy mint only ever happens when the
 * CURRENT furthest-unlocked (under no attempt) is 1 — the one state a
 * missing attempt can honestly represent — and, like every other call, the
 * newly-minted attempt is immediately subject to the same one-step cap below.
 * If a valid attempt already exists, it is always reused, never replaced.
 *
 * ── The one-step cap ──────────────────────────────────────────────────
 *
 * `unlockThrough` never advances the marker by more than one question per
 * call, regardless of what `throughIndex` asks for:
 *
 *     next = min(throughIndex, currentFurthestUnlocked + 1, totalQuestions)
 *
 * This is enforced unconditionally — for an existing attempt and a freshly
 * lazy-created one alike — so neither a caller bug nor a lazily-minted
 * attempt can ever unlock question 3 from question 1 in one call. The single
 * production caller (`QuizComponent#unlockNextQuestion`) only ever asks for
 * "the next one" anyway; this is defense at the service boundary, not a
 * behavior change for that caller.
 *
 * ── Persistence ─────────────────────────────────────────────────────
 *
 * sessionStorage, matching `currentAttemptId` and `SK_RESULTS_REACHED_ATTEMPT`:
 * survives an in-tab refresh (so a legitimate refresh of the furthest
 * question still works) but never leaks into a new tab or a genuinely new
 * session, and is not a security boundary — a user's own DevTools can edit
 * their own sessionStorage regardless of what this service does. This gate
 * protects normal application FLOW (no accidental or casual URL-typing
 * skip-ahead); backend-authoritative scoring is what actually decides
 * correctness, and nothing here changes that.
 *
 * Every read is fully validated (schema version, quiz/attempt identity,
 * integer, >= 1, clamped to the quiz's own question count) — corrupt,
 * missing, stale, or cross-quiz/cross-attempt state always fails closed to 1,
 * never open.
 */

const SCHEMA_VERSION = 1;

interface FurthestUnlockedRecord {
  readonly v: number;
  readonly quizId: string;
  readonly attemptId: string;
  /** 1-based, matching the route's own `:questionIndex` convention. */
  readonly index: number;
}

@Service()
export class QuizProgressionService {
  private readonly quizService = inject(QuizService);

  /**
   * The furthest 1-based question index unlocked for `quizId`'s CURRENT
   * attempt, clamped to `[1, totalQuestions]`. Always a safe, renderable
   * index — callers never need their own extra fallback.
   */
  getFurthestUnlocked(quizId: string, totalQuestions: number): number {
    const max = Math.max(1, Math.trunc(totalQuestions) || 1);
    const record = this.readValidRecord(quizId);
    if (!record) return 1;
    return Math.min(record.index, max);
  }

  /**
   * Unlock AT MOST one question past `quizId`'s current furthest-unlocked
   * index for the current attempt — never further, regardless of what
   * `throughIndex` requests (see the one-step-cap doc above). Monotonic:
   * never lowers the marker. A no-op if `quizId` is empty, `throughIndex` is
   * not a positive integer, the target is already reached, or no attempt
   * could be established (fails closed rather than persisting an
   * un-attributable or over-reaching record).
   *
   * This is the ONLY method that may create an attempt (see the lazy-creation
   * doc above) — `getFurthestUnlocked` and every other read path never do.
   */
  unlockThrough(quizId: string, throughIndex: number, totalQuestions: number): void {
    if (!quizId || !Number.isInteger(throughIndex) || throughIndex < 1) return;

    const max = Math.max(1, Math.trunc(totalQuestions) || 1);
    const current = this.getFurthestUnlocked(quizId, max);

    // The hard, unconditional cap: this call may move the marker forward by
    // at most one question, no matter how far `throughIndex` reaches.
    const next = Math.min(throughIndex, current + 1, max);
    if (next <= current) return; // nothing to unlock — already there or behind

    const attemptId = this.resolveAttemptIdForUnlock(quizId, current);
    if (!attemptId) return;

    this.writeRecord({ v: SCHEMA_VERSION, quizId, attemptId, index: next });
  }

  /**
   * The attempt to attribute THIS unlock write to. Reuses the current
   * attempt when one exists. Otherwise, mints exactly one new attempt — but
   * only when the caller is an approved forward-progression step (this
   * method has no other caller) AND the furthest-unlocked-under-no-attempt
   * reading is 1, the one value a missing attempt can honestly represent
   * (anything else would mean state was reached with no attempt to have
   * earned it, which this service's own invariants make impossible in
   * practice — fail closed rather than trust it).
   */
  private resolveAttemptIdForUnlock(quizId: string, currentFurthest: number): string {
    const existing = this.quizService.getCurrentAttemptId();
    if (existing) return existing;
    if (!quizId || currentFurthest !== 1) return '';
    return this.quizService.startNewAttempt();
  }

  /**
   * Drop the marker entirely — a new attempt has nothing to inherit. Called
   * on every Restart path (both the in-quiz button and the Results-page
   * button's separate reset sequence) and safe to call when nothing is
   * stored.
   */
  clear(): void {
    try {
      sessionStorage.removeItem(SK_FURTHEST_UNLOCKED);
    } catch (err: unknown) {
      swallow('quiz-progression.service.ts#clear', err);
    }
  }

  private readValidRecord(quizId: string): FurthestUnlockedRecord | null {
    let raw: string | null;
    try {
      raw = sessionStorage.getItem(SK_FURTHEST_UNLOCKED);
    } catch (err: unknown) {
      swallow('quiz-progression.service.ts#readValidRecord', err);
      return null;
    }
    if (!raw) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null; // corrupt JSON — fail closed
    }
    if (!parsed || typeof parsed !== 'object') return null;

    const candidate = parsed as Partial<FurthestUnlockedRecord>;
    if (candidate.v !== SCHEMA_VERSION) return null;                 // stale schema
    if (typeof candidate.quizId !== 'string' || candidate.quizId !== quizId) return null; // wrong quiz
    if (typeof candidate.attemptId !== 'string' || !candidate.attemptId) return null;
    if (candidate.attemptId !== this.quizService.getCurrentAttemptId()) return null; // stale/other attempt
    if (typeof candidate.index !== 'number' || !Number.isInteger(candidate.index) || candidate.index < 1) {
      return null; // negative, zero, non-integer
    }

    return candidate as FurthestUnlockedRecord;
  }

  private writeRecord(record: FurthestUnlockedRecord): void {
    try {
      sessionStorage.setItem(SK_FURTHEST_UNLOCKED, JSON.stringify(record));
    } catch (err: unknown) {
      swallow('quiz-progression.service.ts#writeRecord', err);
    }
  }
}
