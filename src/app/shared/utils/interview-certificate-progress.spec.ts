import { InterviewCertificateProgress } from '@shared/models';
import {
  certificateAccessibleSummary,
  certificateInterviewsShown,
  certificateNextAction
} from './interview-certificate-progress';

function progress(over: Partial<InterviewCertificateProgress> = {}): InterviewCertificateProgress {
  const requiredInterviews = over.requiredInterviews ?? 5;
  const qualifyingInterviewsCompleted = over.qualifyingInterviewsCompleted ?? 0;
  const angularExplorerEarned = over.angularExplorerEarned ?? false;
  const interviewsRemaining = Math.max(requiredInterviews - qualifyingInterviewsCompleted, 0);
  return {
    interviewMasterEarned: over.interviewMasterEarned ?? angularExplorerEarned,
    angularExplorerEarned,
    qualifyingInterviewsCompleted,
    requiredInterviews,
    interviewsRemaining,
    isEligible: angularExplorerEarned && qualifyingInterviewsCompleted >= requiredInterviews,
    isUnlocked: false,
    ...over
  };
}

describe('certificateNextAction', () => {
  it('30. uses SINGULAR wording for one interview remaining', () => {
    const msg = certificateNextAction(progress({ angularExplorerEarned: true, qualifyingInterviewsCompleted: 4 }));
    expect(msg).toBe('Complete 1 more interview to earn your certificate.');
    expect(msg).not.toMatch(/interviews/);
  });

  it('31. uses PLURAL wording for multiple interviews remaining', () => {
    const msg = certificateNextAction(progress({ angularExplorerEarned: true, qualifyingInterviewsCompleted: 3 }));
    expect(msg).toBe('Complete 2 more interviews to earn your certificate.');
  });

  it('points to Angular Explorer when interviews are done but Explorer is locked', () => {
    const msg = certificateNextAction(progress({ angularExplorerEarned: false, qualifyingInterviewsCompleted: 5 }));
    expect(msg).toBe('Unlock Angular Explorer to earn your certificate.');
  });

  it('guides both when both requirements are incomplete', () => {
    const msg = certificateNextAction(progress({ angularExplorerEarned: false, qualifyingInterviewsCompleted: 2 }));
    expect(msg).toBe('Continue earning achievements and completing interviews.');
  });

  it('is empty when eligible or already unlocked (no next action)', () => {
    expect(certificateNextAction(progress({ angularExplorerEarned: true, qualifyingInterviewsCompleted: 5 }))).toBe('');
    expect(certificateNextAction(progress({ isUnlocked: true }))).toBe('');
  });
});

describe('certificateAccessibleSummary', () => {
  it('46. summarises Explorer status, counts, and remaining in one sentence', () => {
    const s = certificateAccessibleSummary(progress({ angularExplorerEarned: true, qualifyingInterviewsCompleted: 3 }));
    expect(s).toContain('Angular Explorer unlocked.');
    expect(s).toContain('3 of 5 required interviews completed.');
    expect(s).toContain('2 interviews remaining.');
  });

  it('uses singular "1 interview remaining"', () => {
    const s = certificateAccessibleSummary(progress({ angularExplorerEarned: true, qualifyingInterviewsCompleted: 4 }));
    expect(s).toContain('1 interview remaining.');
  });

  it('announces the unlocked state', () => {
    expect(certificateAccessibleSummary(progress({ isUnlocked: true })))
      .toBe('Angular Interview Master certificate unlocked.');
  });

  it('caps the announced count so it never reads "18 of 5"', () => {
    const s = certificateAccessibleSummary(progress({ qualifyingInterviewsCompleted: 18 }));
    expect(s).toContain('5 of 5 required interviews completed.');
    expect(s).not.toContain('18 of 5');
  });
});

describe('certificateInterviewsShown', () => {
  it('passes the real count through while below the requirement', () => {
    expect(certificateInterviewsShown(progress({ qualifyingInterviewsCompleted: 3 }))).toBe(3);
  });

  it('caps at the requirement — a user with 18 qualifying interviews shows 5, not 18', () => {
    expect(certificateInterviewsShown(progress({ qualifyingInterviewsCompleted: 18 }))).toBe(5);
  });
});
