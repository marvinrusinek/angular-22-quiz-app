import { InterviewDifficulty } from './AssessmentConfig.model';

// Per-topic (source quiz) score within an interview result.
export interface InterviewTopicScore {
  quizId: string;
  title: string;
  correct: number;
  total: number;
  percentage: number;
}

// The computed outcome of a submitted interview/assessment. Derived from the
// generated assessment + the user's answers; NEVER written to topic-quiz
// progress/best-score/achievement state.
export interface InterviewResult {
  total: number;
  answered: number;
  unanswered: number;
  correct: number;
  incorrect: number;
  percentage: number; // 0–100, rounded
  timeUsedSeconds: number;
  timeRemainingSeconds: number;
  difficulty: InterviewDifficulty;
  topicIds: string[];
  perTopic: InterviewTopicScore[];
  submittedByExpiry: boolean;
  // Assessment Integrity Mode: number of focus-loss episodes recorded during the
  // session (neutral/informational only — NEVER affects the score).
  focusChanges: number;
  // ── role-preset metadata (absent for Custom interviews) ──
  // Copied from the generated assessment's config so Results and History can
  // label the attempt without re-deriving anything.
  presetId?: string;
  presetName?: string;
}
