import { Service } from '@angular/core';

import {
  INTERVIEW_SESSION_REFERENCE_VERSION,
  parseSessionReference,
  SK_INTERVIEW_SESSION_REF,
  type PersistedInterviewSessionReference
} from '@shared/models/interview/interview-session-reference.model';
import { readSessionJson, removeSessionKey, writeSessionJson } from '@shared/utils/session-storage';

/**
 * Owns the minimal Interview session reference in sessionStorage.
 *
 * Deliberately ignorant of the API, questions, answers and scoring — it moves
 * three fields in and out of storage and purges legacy answer-bearing keys.
 * Storage is treated as untrusted input on every read.
 */

/**
 * Legacy ACTIVE-session keys that could contain a generated assessment,
 * correctness or saved answers.
 *
 * `interviewSession` (v1) persisted `{ assessment: GeneratedAssessment,
 * answersByIndex, ... }` — a full answer key including per-option `correct`
 * flags and explanations. That is exactly what this migration removes from the
 * browser, so it is purged on first run.
 */
export const LEGACY_ACTIVE_INTERVIEW_KEYS: readonly string[] = [
  'interviewSession',
  /**
   * `interviewResultRefs:v1` briefly held read-only bearer tokens for SUBMITTED
   * sessions in localStorage, so Interview History could reopen a past review.
   * The rule is now absolute — no Interview token is persisted outside
   * `interviewSessionRef:v2` in sessionStorage — so any value already written
   * is purged on first run rather than left to expire on its own.
   */
  'interviewResultRefs:v1'
];

/**
 * Keys NOT touched, and why:
 *   assessmentIntegrity            client-observed focus count; no answers, own lifecycle
 *   __interviewSeconds             Playwright timer hook; no answers
 *   interviewAttemptHistory:v1     sanitized in Stage 9E, not here
 *   interviewCertificate:v1        certificate record; no answers
 *   interviewCertificateQualifiedAt:v1
 *   quizBestScores / quizAchievements / completedQuizIds / theme / everything else
 */
@Service()
export class InterviewSessionReferenceStorage {
  read(): PersistedInterviewSessionReference | null {
    // Check the RAW string first: readSessionJson swallows a parse failure and
    // returns the default, so a malformed value is indistinguishable from an
    // absent one at that layer — and would be left in storage forever.
    let present: string | null;
    try {
      present = sessionStorage.getItem(SK_INTERVIEW_SESSION_REF);
    } catch {
      return null;   // storage unavailable
    }
    if (present === null) return null;

    const parsed = parseSessionReference(readSessionJson<unknown>(SK_INTERVIEW_SESSION_REF, null));

    // Anything unparseable is removed rather than repaired — a half-valid
    // reference would send the user into a resume that cannot succeed.
    if (!parsed) this.clear();
    return parsed;
  }

  write(sessionId: string, sessionToken: string, currentIndex = 0): void {
    const reference: PersistedInterviewSessionReference = {
      version: INTERVIEW_SESSION_REFERENCE_VERSION,
      sessionId,
      sessionToken,
      currentIndex: Math.max(0, Math.trunc(currentIndex))
    };
    writeSessionJson(SK_INTERVIEW_SESSION_REF, reference);
  }

  /** Position only — never rewrites the session with anything larger. */
  updateCurrentIndex(currentIndex: number): void {
    const existing = this.read();
    if (!existing) return;
    this.write(existing.sessionId, existing.sessionToken, currentIndex);
  }

  clear(): void {
    removeSessionKey(SK_INTERVIEW_SESSION_REF);
  }

  /**
   * Purge legacy answer-bearing ACTIVE Interview payloads. Idempotent, and
   * scoped to an explicit key list so unrelated storage is never touched.
   * Returns the keys actually removed.
   */
  purgeLegacyKeys(): readonly string[] {
    const removed: string[] = [];
    for (const key of LEGACY_ACTIVE_INTERVIEW_KEYS) {
      try {
        if (sessionStorage.getItem(key) !== null) {
          sessionStorage.removeItem(key);
          removed.push(key);
        }
        // The v1 active session was sessionStorage-only, but remove any
        // localStorage copy defensively — it would be an answer key on disk.
        if (localStorage.getItem(key) !== null) {
          localStorage.removeItem(key);
          if (!removed.includes(key)) removed.push(key);
        }
      } catch {
        // Storage unavailable (private mode / disabled) — nothing to purge.
      }
    }
    return removed;
  }
}
