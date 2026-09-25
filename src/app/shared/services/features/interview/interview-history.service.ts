import { computed, inject, Service, signal } from '@angular/core';

import { InterviewResult } from '@shared/models/InterviewResult.model';
import { QuizQuestion } from '@shared/models/QuizQuestion.model';
import { QuestionType } from '@shared/models/question-type.enum';
import {
  INTERVIEW_HISTORY_MAX,
  INTERVIEW_HISTORY_VERSION,
  INTERVIEW_HISTORY_VERSION_V1,
  InterviewAttemptHistoryEntry,
  InterviewAttemptHistoryStore,
  InterviewCompletionReason,
  InterviewTopicHistoryEntry,
  InterviewTrendDirection,
  InterviewTrendPoint,
  InterviewTrends
} from '@shared/models/interview-history.model';
import {
  SK_INTERVIEW_HISTORY,
  SK_INTERVIEW_HISTORY_V1
} from '@shared/constants/session-keys';
import { readLocalJson, removeLocalKey, writeLocalJson } from '@shared/utils/local-storage';
import type { SanitizedAttemptInput } from '@shared/services/interview/interview-result-history.adapter';

import { InterviewAnalyticsService } from './interview-analytics.service';

// A change of ±5 percentage points is the threshold for a directional claim; the
// dead band between is "holding steady". Kept factual — never exaggerated.
const TREND_THRESHOLD = 5;

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clampPct = (v: number): number => Math.max(0, Math.min(100, Math.round(v)));

/** The live questions + answers needed to snapshot a per-question review at
 *  submission. Passed straight from the session; never stored raw. */
export interface InterviewReviewSource {
  questions: readonly QuizQuestion[];
  answersByIndex: Record<number, number[]>;
}

/**
 * Owns Interview Mode performance history end-to-end: reading + validating the
 * persisted store, adding a completed attempt exactly once, enforcing the
 * latest-20 retention window, and exposing the history + derived trends as
 * signals. Storage and trend math live here so the Results component stays
 * presentation-only. Topic Performance is NOT recomputed — it reuses
 * InterviewAnalyticsService's output.
 *
 * Kept entirely separate from topic-quiz progress/best-score/achievement stores.
 */
@Service()
export class InterviewHistoryService {
  private readonly analytics = inject(InterviewAnalyticsService);

  private readonly _history = signal<InterviewAttemptHistoryEntry[]>(this.load());

  /** Retained attempts, chronological (oldest → latest). */
  readonly history = this._history.asReadonly();

  /** Everything the Performance Trends UI needs, derived from `history`. */
  readonly trends = computed<InterviewTrends>(() => summarizeTrends(this._history()));

  // Dedup anchor: the exact result object last recorded. A finalized interview
  // produces one result object; recording it a second time (e.g. a stray
  // re-invocation) is a no-op, while two genuinely-distinct interviews always
  // yield distinct objects and are both saved.
  private lastRecorded: InterviewResult | null = null;
  private seq = 0;

  /**
   * Persist a completed interview. Call this ONCE, at the submission chokepoint
   * (InterviewSessionService.submit), which is already idempotent — so a manual
   * submit racing a timer-expiry submit yields one record. Safe to call with a
   * null/undefined result (no-op) and re-entrant on the same result object.
   *
   * `attemptId` (from the session, stable per attempt) gives DURABLE idempotency:
   * if an entry with that id is already persisted it is not written again — this
   * survives service recreation / reloads / a freshly reconstructed result
   * object, not just repeated calls with the same in-memory object.
   */
  record(
    result: InterviewResult | null | undefined,
    attemptId?: string,
    reviewSource?: InterviewReviewSource
  ): void {
    void reviewSource;   // v2 never retains a review snapshot
    if (!result) return;
    if (result === this.lastRecorded) return;   // same in-memory result → no-op
    // Durable guard: this attempt is already in the persisted history.
    if (attemptId && this._history().some((e) => e.id === attemptId)) {
      this.lastRecorded = result;
      return;
    }
    this.lastRecorded = result;

    this.append(this.toEntry(result, attemptId));
  }

  /**
   * Persist a SANITIZED attempt built from the backend result. This is the path
   * the migrated Interview flow uses.
   *
   * Deduplicated by `sessionId`, which is stable on the SERVER: navigating to
   * Results, refreshing it, remounting the component, re-fetching `GET /result`
   * and re-submitting an already-submitted session all describe ONE attempt and
   * must produce ONE record. Score + timestamp cannot do this job — a refresh
   * reproduces both exactly, and two different attempts can legitimately share
   * them.
   */
  recordAttempt(input: SanitizedAttemptInput): void {
    if (!input.sessionId) return;
    if (this._history().some((e) => e.sessionId === input.sessionId)) return;

    this.append({
      id: this.nextId(),
      sessionId: input.sessionId,
      attemptNumber: this.nextAttemptNumber(),
      completedAt: input.completedAt,
      score: input.score,
      totalQuestions: input.totalQuestions,
      percentage: input.percentage,
      completionReason: input.completionReason,
      answered: input.answered,
      unanswered: input.unanswered,
      incorrect: input.incorrect,
      // `durationSeconds` has always meant "time the attempt took" to the
      // history UI, which is the backend's timeUsedSeconds.
      durationSeconds: input.timeUsedSeconds,
      timeUsedSeconds: input.timeUsedSeconds,
      submittedByExpiry: input.submittedByExpiry,
      focusChanges: input.focusChanges,
      configKind: input.configKind,
      presetId: input.presetId,
      presetName: input.presetName,
      configuredDifficulty: input.configuredDifficulty,
      selectedTopicIds: [...input.selectedTopicIds],
      topicPerformance: input.topicPerformance
    });
  }

  private append(entry: InterviewAttemptHistoryEntry): void {
    // Append + keep only the latest N (drops the oldest, preserves order).
    const attempts = [...this._history(), entry].slice(-INTERVIEW_HISTORY_MAX);
    this._history.set(attempts);
    this.save(attempts);
  }

  /**
   * Clear all Interview Mode history. Exposed for a future global "clear all
   * progress" action — it is NOT wired to any destructive UI here, and is never
   * triggered by a refresh, a new interview, returning to the builder, or
   * clearing the active session.
   */
  clear(): void {
    this.lastRecorded = null;
    this._history.set([]);
    removeLocalKey(SK_INTERVIEW_HISTORY);
  }

  // ── internals ───────────────────────────────────────────────────
  private toEntry(
    result: InterviewResult,
    attemptId?: string
  ): InterviewAttemptHistoryEntry {
    // Reuse Topic Performance analytics rather than re-deriving topic tallies.
    const topicPerformance: InterviewTopicHistoryEntry[] = this.analytics
      .analyze(result)
      .topics.map((t) => ({
        topicId: t.topicId,
        topicName: t.topicName,
        correct: t.correct,
        total: t.total,
        percentage: t.percentage
      }));

    const total = Math.max(0, result.total);
    const score = Math.max(0, Math.min(result.correct, total));   // never exceed total

    return {
      id: attemptId && attemptId.length > 0 ? attemptId : this.nextId(),
      attemptNumber: this.nextAttemptNumber(),
      completedAt: new Date().toISOString(),
      score,
      totalQuestions: total,
      percentage: clampPct(result.percentage),
      completionReason: result.submittedByExpiry ? 'time-expired' : 'submitted',
      durationSeconds: Math.max(0, Math.floor(result.timeUsedSeconds ?? 0)),
      configuredDifficulty: result.difficulty,
      // Preset metadata travels from the assessment config via InterviewResult.
      // Absent for Custom, so Custom entries keep exactly their old shape.
      configKind: result.presetId ? 'preset' : undefined,
      presetId: result.presetId,
      presetName: result.presetName,
      selectedTopicIds: [...(result.topicIds ?? [])],
      topicPerformance
    };
  }

  private nextId(): string {
    this.seq += 1;
    // Timestamp + monotonic sequence → unique even for back-to-back saves.
    return `att_${Date.now().toString(36)}_${this.seq}`;
  }

  // The next lifetime attempt number. Derived from the retained max: the newest
  // retained entry always holds the highest number, so this keeps increasing even
  // as older attempts age out of the window.
  private nextAttemptNumber(): number {
    const maxSoFar = this._history().reduce((m, e) => Math.max(m, e.attemptNumber ?? 0), 0);
    return maxSoFar + 1;
  }

  private load(): InterviewAttemptHistoryEntry[] {
    // readLocalJson already returns null on missing/invalid JSON; validation
    // then rejects unsupported versions / malformed entries and de-dupes by id.
    let validated = validateHistoryStore(readLocalJson<unknown>(SK_INTERVIEW_HISTORY, null));

    // No v2 store yet → try migrating v1. Only when v2 is genuinely absent, so
    // a later run can never resurrect v1 data over newer records.
    if (validated.length === 0 && readLocalJson<unknown>(SK_INTERVIEW_HISTORY, null) === null) {
      validated = this.migrateV1();
    }
    // One-time migration: legacy records predate attemptNumber. Assign numbers by
    // chronological position and persist, so numbering is stable from here on.
    if (validated.some((e) => e.attemptNumber == null)) {
      const migrated = validated.map((e, i) => ({ ...e, attemptNumber: i + 1 }));
      if (migrated.length > 0) this.save(migrated);
      return migrated;
    }
    return validated;
  }

  /**
   * One-time v1 → v2 migration.
   *
   * v1 records carried a full `review` snapshot — question text, option text,
   * per-option `correct` flags and explanations — i.e. a durable answer key in
   * localStorage. Every safe summary/analytics field is carried across by name;
   * the review and any unrecognised nested data are dropped rather than copied.
   *
   * Idempotent: v1 is removed only after v2 has been written, so an interrupted
   * migration simply runs again. Unrelated storage is never touched.
   */
  private migrateV1(): InterviewAttemptHistoryEntry[] {
    const raw = readLocalJson<unknown>(SK_INTERVIEW_HISTORY_V1, null);
    if (raw === null) return [];

    const migrated = migrateV1Attempts(raw);

    // Write v2 FIRST. If this throws (quota), v1 stays put and nothing is lost.
    this.save(migrated);
    removeLocalKey(SK_INTERVIEW_HISTORY_V1);

    return migrated;
  }

  private save(attempts: InterviewAttemptHistoryEntry[]): void {
    const store: InterviewAttemptHistoryStore = {
      version: INTERVIEW_HISTORY_VERSION,
      attempts
    };
    writeLocalJson(SK_INTERVIEW_HISTORY, store);
  }
}

// ── filtering (client-side, pure) ─────────────────────────────────────

/** Interview History filter — matches the completion reason (or all). */
export type InterviewHistoryFilter = 'all' | 'submitted' | 'time-expired';

/** Filter attempts by completion reason, preserving order. */
export function filterAttempts(
  attempts: readonly InterviewAttemptHistoryEntry[],
  filter: InterviewHistoryFilter
): InterviewAttemptHistoryEntry[] {
  if (filter === 'all') return [...attempts];
  return attempts.filter((a) => a.completionReason === filter);
}

// ── pure helpers (exported for tests) ─────────────────────────────────

/**
 * Validate an untrusted persisted store into a clean attempts array. Returns []
 * on anything malformed — wrong version, non-array attempts, invalid JSON
 * (already collapsed to null upstream) — and drops individual bad entries rather
 * than discarding the whole history. Never throws.
 */
export function validateHistoryStore(raw: unknown): InterviewAttemptHistoryEntry[] {
  if (!raw || typeof raw !== 'object') return [];
  const store = raw as Partial<InterviewAttemptHistoryStore>;
  if (store.version !== INTERVIEW_HISTORY_VERSION) return [];
  if (!Array.isArray(store.attempts)) return [];

  const clean = store.attempts
    .map(validateAttemptEntry)
    .filter((e): e is InterviewAttemptHistoryEntry => e !== null);

  // De-duplicate by id (keep the first occurrence) — the id is the attempt's
  // dedup anchor and duplicates would corrupt numbering / trend counts.
  const seen = new Set<string>();
  const deduped = clean.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));

  // Defensive: enforce chronological (oldest → latest) order. This is a no-op for
  // our own writes (always appended in order) but protects trend/direction logic
  // from a manually-edited or out-of-order store. Array.prototype.sort is stable,
  // so equal timestamps keep their original relative order. Then apply retention.
  const ordered = deduped.sort((a, b) => a.completedAt.localeCompare(b.completedAt));
  return ordered.slice(-INTERVIEW_HISTORY_MAX);
}

/**
 * Validate a single attempt entry; returns a normalised copy or null. Beyond
 * basic type/range checks this rejects internally-inconsistent records rather
 * than storing nonsense: score must not exceed totalQuestions, completedAt must
 * be a parseable date, and a negative duration is treated as "not recorded".
 */
export function validateAttemptEntry(raw: unknown): InterviewAttemptHistoryEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;

  if (typeof e['id'] !== 'string' || e['id'].length === 0) return null;
  if (typeof e['completedAt'] !== 'string' || Number.isNaN(Date.parse(e['completedAt']))) return null;
  if (!isFiniteNum(e['score']) || e['score'] < 0) return null;
  if (!isFiniteNum(e['totalQuestions']) || e['totalQuestions'] <= 0) return null;
  if (!isFiniteNum(e['percentage'])) return null;

  const totalQuestions = Math.round(e['totalQuestions']);
  const score = Math.round(e['score']);
  if (score > totalQuestions) return null;   // internally inconsistent

  const reason: InterviewCompletionReason =
    e['completionReason'] === 'time-expired' ? 'time-expired' : 'submitted';

  // A finite, non-negative attempt number survives; anything else is dropped and
  // re-derived by the load-time migration.
  const attemptNumber =
    isFiniteNum(e['attemptNumber']) && e['attemptNumber'] > 0
      ? Math.round(e['attemptNumber'])
      : undefined;

  // Duration must be >= 0; a negative/invalid value means "not recorded".
  const durationSeconds =
    isFiniteNum(e['durationSeconds']) && e['durationSeconds'] >= 0
      ? Math.floor(e['durationSeconds'])
      : undefined;

  const selectedTopicIds = Array.isArray(e['selectedTopicIds'])
    ? e['selectedTopicIds'].filter((t): t is string => typeof t === 'string')
    : [];

  const topicPerformance = Array.isArray(e['topicPerformance'])
    ? e['topicPerformance']
        .map(validateTopicEntry)
        .filter((t): t is InterviewTopicHistoryEntry => t !== null)
    : [];

  const optionalCount = (key: string): number | undefined =>
    isFiniteNum(e[key]) && (e[key] as number) >= 0 ? Math.round(e[key] as number) : undefined;

  return {
    id: e['id'],
    // Server-stable dedup key. Absent on migrated v1 records.
    sessionId: typeof e['sessionId'] === 'string' && e['sessionId'].length > 0
      ? e['sessionId']
      : undefined,
    attemptNumber,
    completedAt: e['completedAt'],
    score,
    totalQuestions,
    percentage: clampPct(e['percentage']),   // clamp impossible percentages
    completionReason: reason,
    durationSeconds,
    configuredDifficulty:
      typeof e['configuredDifficulty'] === 'string' ? e['configuredDifficulty'] : undefined,
    configKind: e['configKind'] === 'preset' ? 'preset' : undefined,
    presetId: typeof e['presetId'] === 'string' ? e['presetId'] : undefined,
    presetName: typeof e['presetName'] === 'string' ? e['presetName'] : undefined,
    selectedTopicIds,
    topicPerformance,

    // v2 summary fields. Absent → "not recorded"; never defaulted to a number
    // that would look like real data.
    answered: optionalCount('answered'),
    unanswered: optionalCount('unanswered'),
    incorrect: optionalCount('incorrect'),
    timeUsedSeconds: optionalCount('timeUsedSeconds'),
    submittedByExpiry:
      typeof e['submittedByExpiry'] === 'boolean' ? e['submittedByExpiry'] : undefined,
    focusChanges: optionalCount('focusChanges')
  };
}

/**
 * Migrate a v1 store into sanitized v2 entries.
 *
 * Safe fields are carried across BY NAME. `review` — and anything else not
 * explicitly recognised — is dropped: a partially-valid record contributes its
 * recoverable summary rather than dragging unsafe nested data along, and a
 * record too broken to validate is discarded entirely.
 */
export function migrateV1Attempts(raw: unknown): InterviewAttemptHistoryEntry[] {
  if (!raw || typeof raw !== 'object') return [];
  const store = raw as { version?: unknown; attempts?: unknown };

  // Accept v1 explicitly, and also a version-less store (very old writes).
  if (store.version !== INTERVIEW_HISTORY_VERSION_V1 && store.version !== undefined) return [];
  if (!Array.isArray(store.attempts)) return [];

  const clean = store.attempts
    // validateAttemptEntry already ignores every v1-only field, so the review
    // snapshot cannot survive this step even if it is well-formed.
    .map(validateAttemptEntry)
    .filter((e): e is InterviewAttemptHistoryEntry => e !== null);

  const seen = new Set<string>();
  const deduped = clean.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));

  return deduped
    .sort((a, b) => a.completedAt.localeCompare(b.completedAt))
    .slice(-INTERVIEW_HISTORY_MAX)
    // Numbering stays stable across the migration.
    .map((e, i) => ({ ...e, attemptNumber: e.attemptNumber ?? i + 1 }));
}

// ── v1 review snapshots: REMOVED ─────────────────────────────────────
//
// buildReviewSnapshot / validateReviewSnapshots and their validators lived
// here. They produced the durable per-question answer key that v2 no longer
// persists. Current-session review now comes from the backend result; a
// sanitized historical record has no review at all.

function validateTopicEntry(raw: unknown): InterviewTopicHistoryEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  if (typeof t['topicId'] !== 'string' || t['topicId'].length === 0) return null;
  if (!isFiniteNum(t['correct']) || !isFiniteNum(t['total']) || !isFiniteNum(t['percentage'])) {
    return null;
  }
  const total = Math.round(t['total']);
  const correct = Math.round(t['correct']);
  // A topic must have a positive total and a correct count within [0, total].
  if (total <= 0 || correct < 0 || correct > total) return null;
  return {
    topicId: t['topicId'],
    topicName: typeof t['topicName'] === 'string' ? t['topicName'] : t['topicId'],
    correct,
    total,
    percentage: clampPct(t['percentage']),
    incorrect:
      isFiniteNum(t['incorrect']) && t['incorrect'] >= 0 ? Math.round(t['incorrect']) : undefined,
    unanswered:
      isFiniteNum(t['unanswered']) && t['unanswered'] >= 0 ? Math.round(t['unanswered']) : undefined
  };
}

/**
 * Derive the trend summary from retained attempts (chronological in → out).
 * Pure: latest/best/average/change + an encouraging, factual interpretation.
 * Makes NO directional claim with fewer than two attempts.
 */
export function summarizeTrends(
  attempts: readonly InterviewAttemptHistoryEntry[]
): InterviewTrends {
  const n = attempts.length;
  const points: InterviewTrendPoint[] = attempts.map((a, i) => ({
    id: a.id,
    index: i + 1,
    completedAt: a.completedAt,
    score: a.score,
    totalQuestions: a.totalQuestions,
    percentage: a.percentage,
    completionReason: a.completionReason,
    isLatest: i === n - 1
  }));

  if (n === 0) {
    return {
      points, count: 0, latest: null, best: null, average: null,
      change: null, direction: 'none', interpretation: '', isPersonalBest: false
    };
  }

  const pcts = attempts.map((a) => a.percentage);
  const latest = pcts[n - 1];
  const best = Math.max(...pcts);
  const average = Math.round(pcts.reduce((s, p) => s + p, 0) / n);
  const change = n >= 2 ? latest - pcts[n - 2] : null;

  // New personal best: the latest attempt STRICTLY beats every previous one.
  // Requires ≥ 2 attempts (a first attempt is never a "best" to celebrate) and
  // excludes ties — matching a prior best doesn't earn the badge.
  const isPersonalBest = n >= 2 && latest > Math.max(...pcts.slice(0, n - 1));

  let direction: InterviewTrendDirection = 'none';
  let interpretation = '';
  if (change !== null) {
    if (change >= TREND_THRESHOLD) {
      direction = 'improving';
      interpretation = 'Your interview performance is improving.';
    } else if (change <= -TREND_THRESHOLD) {
      direction = 'declining';
      interpretation = 'Your latest score was lower. Review the topics that need attention and try again.';
    } else {
      direction = 'steady';
      interpretation = 'Your recent performance is holding steady.';
    }
  }

  return { points, count: n, latest, best, average, change, direction, interpretation, isPersonalBest };
}
