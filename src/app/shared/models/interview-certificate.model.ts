/**
 * Angular Interview Master Certificate — a reward for sustained MASTERY across
 * the app. Eligibility (as of the 2026-07 revision) is TWO requirements, both
 * REUSING existing state — never a second calculation:
 *   1. the Angular Explorer achievement is earned (which itself already requires
 *      every other achievement, including Interview Master → highest readiness
 *      tier + ≥90% score, so those are NOT re-checked here), AND
 *   2. at least REQUIRED_CERTIFICATE_INTERVIEWS completed interviews exist in the
 *      validated Interview History.
 * Only the issued certificate itself is persisted here.
 */
import { InterviewReadinessBand } from './interview-readiness.model';

/** Storage schema version. Bump only on a breaking shape change. */
export const INTERVIEW_CERTIFICATE_VERSION = 1 as const;

/** Human-facing certificate title. */
export const CERTIFICATE_TITLE = 'Angular Interview Master';

/**
 * Interview-Master thresholds. Kept here as the SINGLE source of that bar —
 * AchievementService's Interview Master rule imports them. The certificate no
 * longer checks these directly (they are implied by Angular Explorer), so they
 * are NOT duplicated in the certificate eligibility rule.
 */
export const CERTIFICATE_MIN_SCORE = 90;
export const CERTIFICATE_REQUIRED_BAND: InterviewReadinessBand = 'interview-ready';

/** Completed interviews required for the certificate. Centralized (no magic numbers). */
export const REQUIRED_CERTIFICATE_INTERVIEWS = 5;

/** Certificate id prefix, e.g. `AQ-2026-000128`. */
export const CERTIFICATE_ID_PREFIX = 'AQ';

/**
 * Reactive certificate progress — produced by the certificate service, rendered
 * (never recalculated) by the Results + Interview Builder UIs.
 */
export interface InterviewCertificateProgress {
  // When the certificate journey began (topic curriculum finished). Undefined
  // until qualification starts; only interviews on/after it count.
  qualificationStartedAt?: string;
  interviewMasterEarned: boolean; // the Interview Master achievement
  angularExplorerEarned: boolean; // the achievement source of truth (implies all)
  qualifyingInterviewsCompleted: number; // completed interviews since qualification
  requiredInterviews: number; // REQUIRED_CERTIFICATE_INTERVIEWS
  interviewsRemaining: number; // max(required - qualifying, 0)
  isEligible: boolean; // both requirements satisfied
  isUnlocked: boolean; // persisted certificate state
}

/**
 * The persisted certificate. Deliberately minimal: the unlock flag, the issue
 * date, the stable id, and an optional user-entered name. Readiness tier and
 * score are NOT stored — they are shown live from the reused services, so this
 * record never duplicates achievement / readiness / interview-history data.
 */
export interface InterviewCertificateRecord {
  version: typeof INTERVIEW_CERTIFICATE_VERSION;
  unlocked: boolean;
  unlockedAt: string; // ISO 8601
  certificateId: string; // stable once issued
  recipientName?: string; // optional; user-entered on the certificate page
}
