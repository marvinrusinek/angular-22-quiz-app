import { QuestionVerdictState } from './question-verdict.types';

/**
 * Session-scoped persistence for verdicts the user has ALREADY EARNED.
 *
 * ── Why this exists ───────────────────────────────────────────────
 *
 * The verdict store is in memory, so a page reload empties it. Until now the
 * bundled answer key repainted a previously-answered question after a reload —
 * which is a live correctness dependency, and the last one blocking the asset's
 * removal. Restoring from the key means shipping the key.
 *
 * ── The security boundary ─────────────────────────────────────────
 *
 * ONLY questions whose authorized `/check` has already come back terminal are
 * written here, and only the facts that check already put on the user's screen:
 *
 *   - how their OWN picks were judged (`selectedVerdicts`)
 *   - whether the question resolved correct (`isResolvedCorrect`)
 *   - the reveal — correct option texts and explanation — and ONLY when the
 *     server actually returned it for that question
 *
 * Nothing is stored for a question the user has not answered. There is no
 * complete key, no future-question data, and nothing derived from
 * `quizInitialState`. Reading this storage tells an attacker exactly what the
 * player already saw, for the questions they already answered.
 *
 * `sessionStorage`, not `localStorage`: earned state is scoped to the session
 * that earned it and dies with the tab.
 *
 * ── Fail closed ───────────────────────────────────────────────────
 *
 * Malformed JSON, an unknown schema version, a foreign quizId, or an entry
 * whose shape does not validate is DISCARDED. There is no repair path and no
 * fallback to local data: a question simply behaves as unanswered, which is the
 * honest state when its earned record cannot be trusted.
 */

/** Bumped whenever the persisted shape changes; older payloads are discarded. */
const SCHEMA_VERSION = 1;

const STORAGE_PREFIX = 'earnedVerdicts:v1:';

/** Only terminal phases are ever persisted — a pending check has earned nothing. */
type EarnedPhase = 'resolved' | 'expired';

/**
 * The minimum a restore needs. Deliberately NOT the whole QuestionVerdictState:
 * `remainingCorrectCount` only matters for the `incomplete` phase, which is
 * never persisted, and `selectedOptionTexts` is recoverable from the verdict
 * keys — so neither is stored.
 */
export interface EarnedVerdictEntry {
  readonly questionText: string;
  readonly phase: EarnedPhase;
  /** The user's OWN picks and how each was judged. */
  readonly selectedVerdicts: readonly (readonly [string, boolean])[];
  readonly isResolvedCorrect: boolean | null;
  /** Present ONLY when the server already revealed it for this question. */
  readonly correctOptionTexts?: readonly string[];
  /** Present ONLY when the server already released it for this question. */
  readonly explanation?: string;
}

interface EarnedVerdictPayload {
  readonly v: number;
  readonly quizId: string;
  readonly entries: readonly EarnedVerdictEntry[];
}

function keyFor(quizId: string): string {
  return STORAGE_PREFIX + quizId;
}

function isTerminal(phase: string): phase is EarnedPhase {
  return phase === 'resolved' || phase === 'expired';
}

/** Structural validation. Anything unexpected fails the whole entry. */
function validEntry(raw: unknown): raw is EarnedVerdictEntry {
  if (!raw || typeof raw !== 'object') return false;
  const e = raw as Record<string, unknown>;

  if (typeof e['questionText'] !== 'string' || e['questionText'].length === 0) return false;
  if (typeof e['phase'] !== 'string' || !isTerminal(e['phase'])) return false;

  if (!Array.isArray(e['selectedVerdicts'])) return false;
  for (const pair of e['selectedVerdicts']) {
    if (!Array.isArray(pair) || pair.length !== 2) return false;
    if (typeof pair[0] !== 'string' || typeof pair[1] !== 'boolean') return false;
  }

  const resolved = e['isResolvedCorrect'];
  if (resolved !== null && typeof resolved !== 'boolean') return false;

  if (e['correctOptionTexts'] !== undefined) {
    if (!Array.isArray(e['correctOptionTexts'])) return false;
    if (e['correctOptionTexts'].some((t) => typeof t !== 'string')) return false;
  }
  if (e['explanation'] !== undefined && typeof e['explanation'] !== 'string') return false;

  return true;
}

/**
 * Reduce a live verdict to what may be persisted, or null when it has earned
 * nothing. The reveal fields are copied only when the server actually supplied
 * them — an expired question that was never revealed stores no correct texts.
 */
export function toEarnedEntry(
  questionText: string,
  state: QuestionVerdictState
): EarnedVerdictEntry | null {
  if (!questionText || !isTerminal(state.phase)) return null;

  const entry: {
    questionText: string;
    phase: EarnedPhase;
    selectedVerdicts: (readonly [string, boolean])[];
    isResolvedCorrect: boolean | null;
    correctOptionTexts?: readonly string[];
    explanation?: string;
  } = {
    questionText,
    phase: state.phase,
    selectedVerdicts: [...state.selectedVerdicts].map(([text, correct]) => [text, correct] as const),
    isResolvedCorrect: state.isResolvedCorrect ?? null
  };

  if (state.correctOptionTexts && state.correctOptionTexts.length > 0) {
    entry.correctOptionTexts = [...state.correctOptionTexts];
  }
  const explanation = (state.explanation ?? '').trim();
  if (explanation.length > 0) entry.explanation = explanation;

  return entry;
}

/** Persist one earned verdict, merging it into this quiz's snapshot. */
export function saveEarnedVerdict(
  quizId: string,
  questionText: string,
  state: QuestionVerdictState
): void {
  const entry = toEarnedEntry(questionText, state);
  if (!quizId || !entry) return;

  try {
    const existing = readPayload(quizId);
    const merged = [
      ...existing.filter((e) => e.questionText !== entry.questionText),
      entry
    ];
    const payload: EarnedVerdictPayload = { v: SCHEMA_VERSION, quizId, entries: merged };
    sessionStorage.setItem(keyFor(quizId), JSON.stringify(payload));
  } catch {
    // Storage full, disabled, or unavailable — restore is a convenience, never
    // a correctness requirement, so a failure to persist is silent.
  }
}

/** Every valid earned entry for this quiz. Invalid payloads yield nothing. */
export function readPayload(quizId: string): readonly EarnedVerdictEntry[] {
  if (!quizId) return [];
  try {
    const raw = sessionStorage.getItem(keyFor(quizId));
    if (!raw) return [];

    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return [];

    const payload = parsed as Record<string, unknown>;
    // Schema version and quiz identity must both match. A payload written for
    // another quiz is never consumed, even if the key were tampered with.
    if (payload['v'] !== SCHEMA_VERSION) return [];
    if (payload['quizId'] !== quizId) return [];
    if (!Array.isArray(payload['entries'])) return [];

    return payload['entries'].filter(validEntry);
  } catch {
    return [];   // malformed JSON — discard
  }
}

/** Forget this quiz's earned verdicts (restart, or leaving the quiz). */
export function clearEarnedVerdicts(quizId: string): void {
  if (!quizId) return;
  try {
    sessionStorage.removeItem(keyFor(quizId));
  } catch {
    // nothing to do
  }
}
