/** Centralized storage key prefixes/names used with sessionStorage and localStorage. */

// ── per-question prefixes (appended with question index) ─────────
export const SK_SEL_Q = 'sel_Q';
export const SK_DOT_CONFIRMED = 'dot_confirmed_';
export const SK_MULTI_PERFECT = 'multi_perfect_';
export const SK_DISPLAY_MODE = 'displayMode_';

// ── global keys ──────────────────────────────────────────────────
export const SK_COMPLETED_QUIZ_IDS = 'completedQuizIds';
export const SK_CORRECT_ANSWERS_COUNT = 'correctAnswersCount';
export const SK_IS_ANSWERED = 'isAnswered';
// `<quizId>|<attemptId>` of the attempt that reached the Results page. Lets the
// quiz's last question re-show the Show Results button + message when the user
// comes back with browser Back (which rebuilds the component and wipes the
// in-memory answered evidence). Self-invalidating: Restart / a new attempt mints
// a new attemptId, so a stale marker stops matching without any explicit clear.
export const SK_RESULTS_REACHED_ATTEMPT = 'resultsReachedAttempt';
export const SK_SAVED_QUESTION_INDEX = 'savedQuestionIndex';
// The FURTHEST 1-based question index the current attempt has legitimately
// unlocked (QuizGuard's own source of truth for the direct-route progression
// bypass fix). One record only — this app has one quiz in progress at a time,
// same convention as `currentAttemptId`. Bound to quizId + attemptId + a schema
// version; anything else (missing, corrupt, wrong quiz, wrong/old attempt,
// non-integer, out of range) fails closed to question 1. See
// quiz-progression.service.ts.
export const SK_FURTHEST_UNLOCKED = 'furthestUnlockedQuestion:v1';
export const SK_SELECTED_OPTIONS_MAP = 'selectedOptionsMap';
export const SK_SHUFFLED_QUESTIONS = 'shuffledQuestions';
export const SK_SHUFFLED_QUESTIONS_QUIZ_ID = 'shuffledQuestionsQuizId';
export const SK_STARTED_QUIZ_IDS = 'startedQuizIds';
export const SK_USER_ANSWERS = 'userAnswers';

// ── durable preferences (localStorage) ───────────────────────────
export const SK_QUIZ_SORT_DIFFICULTY = 'quizSortDifficulty';
export const SK_QUIZ_SORT_ALPHA = 'quizSortAlpha';
export const SK_QUIZ_BEST_SCORES = 'quizBestScores';
export const SK_QUIZ_ACHIEVEMENTS = 'quizAchievements';

// ── per-session state (sessionStorage) ───────────────────────────
export const SK_QUIZ_SEARCH_TERM = 'quizSearchTerm';

// Active Interview Mode session, persisted so a mid-assessment refresh resumes
// the SAME assessment/answers/position with the correct remaining time. Only an
// 'active' session is stored; cleared on submit or abandon.
export const SK_INTERVIEW_SESSION = 'interviewSession';

// Assessment Integrity Mode state (focus-loss count / pending warning) for an
// active Interview session. Its OWN key — kept separate from the interview
// session payload and NEVER mixed into topic-quiz progress/achievements/scores.
export const SK_ASSESSMENT_INTEGRITY = 'assessmentIntegrity';

// Interview Mode performance history — a durable, versioned localStorage store of
// the latest completed assessments (compact analytics only; NEVER full questions/
// answers). Powers the Performance Trends chart. Kept fully separate from
// topic-quiz progress/best-score/achievement stores.
//
// v2 is the SANITIZED schema. v1 additionally retained a per-question review
// snapshot — question text, option text, per-option `correct` flags and
// explanations — i.e. a durable answer key on disk. That is migrated to v2 and
// discarded on first load; see InterviewHistoryService#migrateV1.
export const SK_INTERVIEW_HISTORY = 'interviewAttemptHistory:v2';

/** The v1 key. Read once during migration, then removed. Never written. */
export const SK_INTERVIEW_HISTORY_V1 = 'interviewAttemptHistory:v1';

// Angular Interview Master Certificate — a durable localStorage record of the
// ONE issued certificate (unlocked flag, issue date, stable certificate id, and
// an optional user-entered recipient name). Eligibility is NOT persisted here —
// it is recomputed from the reused Achievements / Readiness / History sources, so
// this store never duplicates achievement, readiness, or interview-history state.
export const SK_INTERVIEW_CERTIFICATE = 'interviewCertificate:v1';

// The certificate QUALIFICATION start date — a single ISO timestamp written ONCE
// when the topic curriculum (Beginner/Intermediate/Advanced Complete) is first
// finished. Only interviews completed on/after it count toward the certificate's
// 5-interview requirement. Kept separate from the issued-certificate record and
// from Interview History (which is never modified).
export const SK_INTERVIEW_CERTIFICATE_QUAL = 'interviewCertificateQualifiedAt:v1';

// General store of RELIABLE raw topic performance (topic quizzes + Weak Areas
// Practice). Deliberately SEPARATE from interviewAttemptHistory:v1, which stays
// interview-only so certificate qualification and interview analytics are
// unaffected.
export const SK_TOPIC_PERFORMANCE_HISTORY = 'topicPerformanceHistory:v1';

// Active Weak Areas Practice session (sessionStorage). Holds the GENERATED
// questions so a refresh resumes the identical session rather than reshuffling.
export const SK_PRACTICE_SESSION = 'weakAreasPracticeSession:v1';
