import { QuizDifficulty } from './Quiz.model';

// Interview Mode layers a 'mixed' selection on top of the real per-quiz
// difficulty values ('beginner' | 'intermediate' | 'advanced'). 'mixed' is an
// Interview-only concept — it is NOT a value present in quiz.json.
export type InterviewDifficulty = QuizDifficulty | 'mixed';

// The allowed question counts. Duration is derived, never chosen (see
// DURATION_SECONDS_BY_COUNT), so v1 exposes no timer-duration selector.
export type AssessmentQuestionCount = 10 | 20 | 30;

// Question counts the ROLE PRESETS use. Kept as a separate literal union so the
// Custom builder's three choices stay exactly as they were — presets are the
// only thing that may introduce 15 or 25.
export type PresetQuestionCount = 15 | 25;

// Any count the engine can be asked for (Custom's three, plus preset-only sizes).
export type BuildableQuestionCount = AssessmentQuestionCount | PresetQuestionCount;

// A reusable, UI-agnostic description of the assessment to build. The
// AssessmentBuilder answers "given this config, which questions?" — nothing
// about how the interview behaves lives here.
export interface AssessmentConfig {
  difficulty: InterviewDifficulty;
  topicIds: string[]; // source quizIds (topics)
  questionCount: BuildableQuestionCount;
  // ── preset metadata (absent for Custom, which is unchanged) ──
  // Present only when the assessment came from a role preset. Carried through
  // the session snapshot into the result + history so a completed attempt can be
  // labelled reliably later.
  presetId?: string;
  presetName?: string; // snapshot of the name at build time
  // Presets declare their own duration instead of deriving it from the count.
  durationSecondsOverride?: number;
}

// question count → total interview seconds (10→15m, 20→30m, 30→45m).
export const DURATION_SECONDS_BY_COUNT: Record<AssessmentQuestionCount, number> = {
  10: 15 * 60,
  20: 30 * 60,
  30: 45 * 60
};
