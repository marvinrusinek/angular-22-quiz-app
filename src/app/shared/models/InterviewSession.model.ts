import { GeneratedAssessment } from './GeneratedAssessment.model';

// Whether correctness feedback (FET, colors, icons) is shown immediately
// (normal topic quizzes) or deferred until submission (Interview Mode).
export type FeedbackMode = 'immediate' | 'deferred';

export type InterviewSessionStatus = 'active' | 'submitting' | 'submitted';

// The full active-interview state, persisted to sessionStorage so a browser
// refresh resumes the SAME interview at the same position with the correct
// remaining time (derived from `expiresAt`, never reset to the original
// duration). Cleared on submit or abandon.
export interface InterviewSession {
  assessment: GeneratedAssessment;
  answersByIndex: Record<number, number[]>; // display index → selected optionIds
  currentIndex: number;
  expiresAt: number; // epoch ms — drift-proof remaining time
  status: InterviewSessionStatus;
}
