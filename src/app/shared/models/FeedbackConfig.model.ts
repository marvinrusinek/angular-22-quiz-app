export type FeedbackKey = number | string;

export interface FeedbackConfig {
  showFeedback: boolean;
  isCorrect?: boolean;
  icon?: string;
  text?: string;
}
