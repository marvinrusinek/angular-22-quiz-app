import { DEFAULT_DOCUMENT_TITLE, topicQuizDocumentTitle } from './topic-quiz-document-title';

describe('topicQuizDocumentTitle', () => {
  it('composes "<milestone> Quiz | Angular Quiz App" for a plain milestone', () => {
    expect(topicQuizDocumentTitle('Dependency Injection')).toBe(
      'Dependency Injection Quiz | Angular Quiz App'
    );
  });

  it('does not duplicate "Quiz" when the milestone already ends with it', () => {
    expect(topicQuizDocumentTitle('Angular Fundamentals Quiz')).toBe(
      'Angular Fundamentals Quiz | Angular Quiz App'
    );
  });

  it('is case-insensitive when checking for a trailing "Quiz"', () => {
    expect(topicQuizDocumentTitle('Some Topic QUIZ')).toBe(
      'Some Topic QUIZ | Angular Quiz App'
    );
  });

  it('trims surrounding whitespace before composing', () => {
    expect(topicQuizDocumentTitle('  TypeScript  ')).toBe(
      'TypeScript Quiz | Angular Quiz App'
    );
  });

  it('falls back to the bare default title for an empty or whitespace-only milestone', () => {
    expect(topicQuizDocumentTitle('')).toBe(DEFAULT_DOCUMENT_TITLE);
    expect(topicQuizDocumentTitle('   ')).toBe(DEFAULT_DOCUMENT_TITLE);
  });

  it('only matches "quiz" as a trailing whole word, not as a substring', () => {
    // "Quizzes" ends with "quiz" as a SUBSTRING but not as the whole word
    // "quiz" — must still append " Quiz" rather than treating it as already present.
    expect(topicQuizDocumentTitle('Angular Quizzes')).toBe(
      'Angular Quizzes Quiz | Angular Quiz App'
    );
  });
});
