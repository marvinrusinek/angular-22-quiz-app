import { findInterviewPreset, interviewConfigLabel } from '@shared/models';
import type { InterviewSessionConfigViewModel } from '@shared/models/interview/interview-view-models';

/**
 * Pure formatting for the Interview Report. Everything here derives from the
 * FINALIZED result's `config` and submission time only — never from a session
 * id, token, question id or any other internal identifier.
 */

/** Prefix of the suggested print/PDF file name. */
export const INTERVIEW_REPORT_TITLE_PREFIX = 'Angular-Interview-Report';

/** "Mid-Level Angular Developer" or "Custom Interview" — the same label Results shows. */
export function reportAssessmentLabel(config: InterviewSessionConfigViewModel): string {
  return interviewConfigLabel(config.mode === 'preset' ? 'preset' : 'custom', config.presetId, undefined);
}

/**
 * The difficulty a user CHOSE. A role preset deliberately mixes difficulties, so
 * only a custom interview has one; a preset yields ''. Title-cased for display.
 */
export function reportDifficulty(config: InterviewSessionConfigViewModel): string {
  if (config.mode === 'preset' || !config.difficulty) return '';
  return config.difficulty.charAt(0).toUpperCase() + config.difficulty.slice(1);
}

/**
 * One safe token for the file name: the first word of the preset's display name
 * ("Mid-Level Angular Developer" -> "Mid"), "Custom" for a custom interview, and
 * "Preset" if a preset is not one this build knows. Derived from the NAME, so the
 * internal preset id never reaches the title.
 */
export function reportKindSlug(config: InterviewSessionConfigViewModel): string {
  if (config.mode !== 'preset') return 'Custom';
  const name = findInterviewPreset(config.presetId)?.name ?? '';
  const first = name.split(/[\s-]+/)[0]?.replace(/[^A-Za-z0-9]/g, '') ?? '';
  return first || 'Preset';
}

/** Local calendar date as `YYYY-MM-DD` (the user's own date, not UTC). */
export function reportDateStamp(submittedAtMs: number): string {
  const d = new Date(submittedAtMs);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The document title used while printing — browsers commonly offer it as the
 * PDF file name. e.g. `Angular-Interview-Report-Mid-2026-09-26`.
 */
export function interviewReportTitle(
  config: InterviewSessionConfigViewModel,
  submittedAtMs: number
): string {
  return `${INTERVIEW_REPORT_TITLE_PREFIX}-${reportKindSlug(config)}-${reportDateStamp(submittedAtMs)}`;
}

/** Long, human date for the report header, e.g. "September 26, 2026". */
export function formatReportDate(submittedAtMs: number): string {
  return new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'long', day: 'numeric' }).format(
    new Date(submittedAtMs)
  );
}
