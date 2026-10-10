/**
 * The document title set by `src/index.html` and the only fallback this
 * module ever restores to — never hardcoded elsewhere.
 */
export const DEFAULT_DOCUMENT_TITLE = 'Angular Quiz App';

/**
 * Composes the browser tab title for a Topic Quiz's Introduction/Question
 * pages, e.g. "Dependency Injection Quiz | Angular Quiz App". Never
 * duplicates "Quiz" if the quiz's own milestone already ends with it.
 * `milestone` is public catalog metadata (the same text already shown on
 * the Introduction page and the Quiz Selection tile) — never an answer,
 * explanation, or other quiz-content detail.
 */
export function topicQuizDocumentTitle(milestone: string): string {
  const trimmed = milestone.trim();
  if (!trimmed) return DEFAULT_DOCUMENT_TITLE;
  const withQuiz = /\bquiz\s*$/i.test(trimmed) ? trimmed : `${trimmed} Quiz`;
  return `${withQuiz} | ${DEFAULT_DOCUMENT_TITLE}`;
}
