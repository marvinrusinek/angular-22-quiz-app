/**
 * Text-based verdict DTOs for Topic Quizzes.
 *
 * These types are the CONTRACT between the correctness authority and every
 * consumer of it. They deliberately mirror the backend's
 * `POST /api/quizzes/:quizId/check` response, so the later data-source flip is
 * a change of implementation rather than a change of contract.
 *
 * ── What must never appear here ────────────────────────────────────
 *
 * No `Option`, `QuizQuestion` or `Quiz` objects, no `correct` flags read off a
 * source model, no database ids, no question or option ids, no indexes. A
 * consumer holding one of these must have no way to reach the underlying bank —
 * that is what makes the swap to a remote source possible without touching
 * consumers again.
 *
 * Identity is (quizId, exact questionText); options are identified by their
 * exact text within that question.
 */

/** Lifecycle of one question's verdict. Mirrors the backend `status` values. */
export type QuestionVerdictPhase =
  | 'idle'
  | 'checking'
  | 'incomplete'
  | 'resolved'
  | 'expired'
  | 'error';

/** The user's own pick and whether it was right. Only ever for SELECTED options. */
export interface SelectedOptionVerdict {
  readonly text: string;
  readonly correct: boolean;
}

/**
 * Not yet terminal.
 *
 * Carries verdicts for the user's own selections only. An unselected option's
 * correctness is never disclosed here — otherwise partial play on a
 * multiple-answer question becomes a way to enumerate the answer key one click
 * at a time.
 */
export interface QuestionIncompleteResult {
  readonly status: 'incomplete';
  readonly selectedVerdicts: readonly SelectedOptionVerdict[];
  /** How many CORRECT options remain unselected. Never which ones. */
  readonly remainingCorrectCount: number;
}

/** Terminal. The authorized reveal for ONE question. */
export interface QuestionResolvedResult {
  readonly status: 'resolved';
  readonly correct: boolean;
  readonly correctOptionTexts: readonly string[];
  readonly explanation: string;
}

/** Terminal by timer expiry rather than by answering. */
export interface QuestionExpiredResult {
  readonly status: 'expired';
  readonly correctOptionTexts: readonly string[];
  readonly explanation: string;
}

export type QuestionCheckResult =
  | QuestionIncompleteResult
  | QuestionResolvedResult
  | QuestionExpiredResult;

/**
 * Per-question state held by the service.
 *
 * `selectedVerdicts` is a map keyed by the option's EXACT text, so a consumer
 * can ask "was the option I am rendering marked wrong?" without needing an id.
 */
export interface QuestionVerdictState {
  readonly phase: QuestionVerdictPhase;
  readonly selectedOptionTexts: readonly string[];
  readonly selectedVerdicts: ReadonlyMap<string, boolean>;
  readonly remainingCorrectCount: number | null;
  readonly correctOptionTexts: readonly string[];
  readonly explanation: string | null;
  /** Null until the question reaches a terminal phase. */
  readonly isResolvedCorrect: boolean | null;
}

/**
 * One question reaching an authorized terminal state.
 *
 * Identity stays (quizId, exact questionText) — a subscriber matches on the
 * same pair it would query with, so nothing here reintroduces ids or indexes.
 */
export interface TerminalVerdictArrival {
  readonly quizId: string;
  readonly questionText: string;
  readonly state: QuestionVerdictState;
}

export const IDLE_VERDICT_STATE: QuestionVerdictState = {
  phase: 'idle',
  selectedOptionTexts: [],
  selectedVerdicts: new Map<string, boolean>(),
  remainingCorrectCount: null,
  correctOptionTexts: [],
  explanation: null,
  isResolvedCorrect: null
};

/**
 * Why a check could not be evaluated.
 *
 * Deliberately coarse: a consumer needs to know it failed, not which part of
 * the input was wrong. The backend gives one indistinguishable 400 for exactly
 * the same reason, and the local adapter must not be more forthcoming.
 */
export class QuestionVerdictError extends Error {
  public override readonly name = 'QuestionVerdictError';
}
