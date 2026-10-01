import { InterviewCertificateProgress } from '@shared/models';

/**
 * Pure presentation helpers for the certificate progress UI (Results + Interview
 * Builder). They only READ an already-computed progress model — no eligibility
 * logic lives here — so wording (incl. singular/plural) is easy to test and
 * stays identical across surfaces.
 */

/** "1 interview" / "2 interviews" — correct singular/plural. */
function interviewsWord(n: number): string {
  return n === 1 ? $localize`interview` : $localize`interviews`;
}

/**
 * The completed count as shown against the requirement, CAPPED so a user who
 * has done more qualifying interviews than required never sees a nonsensical
 * progress reading like `18 / 5`. This is a progress indicator, not a tally —
 * the uncapped figure stays available on `qualifyingInterviewsCompleted`.
 */
export function certificateInterviewsShown(p: InterviewCertificateProgress): number {
  return Math.min(p.qualifyingInterviewsCompleted, p.requiredInterviews);
}

/**
 * The single clearest next action. Returns '' only when already unlocked (the
 * UI shows the unlocked state instead). ELIGIBLE-but-not-yet-claimed is its own
 * case, not blank: since this feature replaced automatic unlock with an
 * explicit claim step (see InterviewCertificateService's own doc comment),
 * a user can sit in "eligible" indefinitely until they actually claim — the
 * compact callout surfaces that the same way the full certificate page's CTA
 * does, rather than going silent.
 */
export function certificateNextAction(p: InterviewCertificateProgress): string {
  if (p.isUnlocked) return '';
  if (p.isEligible) return $localize`Claim your certificate now.`;

  const explorer = p.angularExplorerEarned;
  const interviewsDone = p.qualifyingInterviewsCompleted >= p.requiredInterviews;

  if (explorer && !interviewsDone) {
    const n = p.interviewsRemaining;
    return $localize`Complete ${n} more ${interviewsWord(n)} to earn your certificate.`;
  }
  if (!explorer && interviewsDone) {
    return $localize`Unlock Angular Explorer to earn your certificate.`;
  }
  // Both requirements still incomplete.
  return $localize`Continue earning achievements and completing interviews.`;
}

/**
 * A single screen-reader sentence summarising certificate progress. Used in an
 * sr-only element (static content — NOT a live region).
 */
export function certificateAccessibleSummary(p: InterviewCertificateProgress): string {
  if (p.isUnlocked) {
    return $localize`Angular Interview Master certificate unlocked.`;
  }
  const explorer = p.angularExplorerEarned
    ? $localize`Angular Explorer unlocked.`
    : $localize`Angular Explorer not yet unlocked.`;
  const counts = $localize`${certificateInterviewsShown(p)} of ${p.requiredInterviews} required interviews completed.`;
  const remaining =
    p.interviewsRemaining > 0
      ? $localize`${p.interviewsRemaining} ${interviewsWord(p.interviewsRemaining)} remaining.`
      : '';
  return [$localize`Certificate progress:`, explorer, counts, remaining].filter(Boolean).join(' ');
}
