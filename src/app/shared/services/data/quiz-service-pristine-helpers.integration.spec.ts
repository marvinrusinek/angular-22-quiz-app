/**
 * QuizService pristine-helper contract tests.
 *
 * These exist because the 2026-05-31 sweep hit a browser-only regression
 * where `shared-option-explanation.service.ts` migrated from an inline
 * pristine-walk (using an HTML-aware `this.normalize()`) to the QuizService
 * helpers (which use the simple `norm()` from `utils/text-norm.ts`). The
 * downstream code compared the helper's output against texts normalized by
 * the HTML-aware function and got mismatched lookups — visible only in the
 * browser, with HTML-containing questions, on click. tsc + 193 Jest tests
 * stayed green.
 *
 * This spec locks down the SHAPE of what the helpers return so any future
 * consumer migration can verify normalization compatibility before merging.
 *
 * Scenarios covered:
 *  - Question-text lookup uses simple norm (trim + lowercase only)
 *  - Option-text values in the returned Set are simple-normed (NOT
 *    HTML-stripped)
 *  - HTML in questionText / option text is preserved through to caller
 *  - getPristineCorrectCountForQuestion returns correct counts for
 *    single-answer (1) and multi-answer (>1) questions
 *  - Empty / null / unknown inputs return empty results without throwing
 *  - Memoization: repeat lookups return the same Set reference
 */
// jsdom doesn't expose structuredClone in some versions; polyfill before
// the QuizService module is loaded (its field initializer calls it).
if (typeof (globalThis as any).structuredClone !== 'function') {
  (globalThis as any).structuredClone = (v: any) => JSON.parse(JSON.stringify(v));
}

import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { Quiz } from '@shared/models/Quiz.model';
import { QuestionType } from '@shared/models/question-type.enum';

import { QuizService } from './quiz.service';

describe('QuizService pristine helpers', () => {
  let service: QuizService;

  // Test fixture: 2 questions
  //  - "What is <code>2+2</code>?" (single-answer, 1 correct, HTML in qText)
  //  - "Which fruits are red?" (multi-answer, 2 correct, plain text)
  const TEST_QUIZ: Quiz = {
    quizId: 'test-pristine',
    quizName: 'Pristine Helpers Test',
    milestone: 'test',
    summary: '',
    image: '',
    questions: [
      {
        questionText: 'What is <code>2+2</code>?',
        explanation: 'addition',
        type: QuestionType.SingleAnswer,
        options: [
          { optionId: 1, text: '3', correct: false } as any,
          { optionId: 2, text: '4', correct: true } as any,
          { optionId: 3, text: '5', correct: false } as any,
        ],
      } as any,
      {
        questionText: 'Which fruits are red?',
        explanation: 'colors',
        type: QuestionType.MultipleAnswer,
        options: [
          { optionId: 1, text: 'Apple', correct: true } as any,
          { optionId: 2, text: 'Banana', correct: false } as any,
          { optionId: 3, text: 'Strawberry', correct: true } as any,
          { optionId: 4, text: 'Blueberry', correct: false } as any,
        ],
      } as any,
    ],
  } as Quiz;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } },
      ],
    });
    service = TestBed.inject(QuizService);
    // Replace real quiz data with the test fixture; reset memo caches so
    // the next helper call rebuilds against the fixture.
    service.quizInitialState = [TEST_QUIZ] as Quiz[];
    (service as any)._pristineByQText = null;
    (service as any)._correctTextsByQText = null;
    (service as any)._correctOptionsByQText = null;
  });

  // ── question-text lookup ────────────────────────────────────

  it('looks up question by simple-normed questionText', () => {
    // Same text, different case + leading whitespace — should still match
    const set = service.getPristineCorrectTextsForQuestion('  WHICH FRUITS ARE RED?  ');
    expect(set.size).toBe(2);
  });

  it('preserves HTML in questionText for lookup (does NOT strip tags)', () => {
    // Must pass the original questionText INCLUDING the <code> tags;
    // simple norm only trims + lowercases.
    const set = service.getPristineCorrectTextsForQuestion('what is <code>2+2</code>?');
    expect(set.size).toBe(1);
  });

  it('returns empty Set when stripping HTML from the lookup key (regression guard)', () => {
    // If a caller HTML-strips before passing in ("what is 2+2?"), the
    // simple-normed cache key won't match — returns empty. This documents
    // the contract that broke shared-option-explanation.service.ts.
    const set = service.getPristineCorrectTextsForQuestion('what is 2+2?');
    expect(set.size).toBe(0);
  });

  // ── option-text shape in returned Set ───────────────────────

  it('returns option texts using simple norm (lowercase + trim only)', () => {
    const set = service.getPristineCorrectTextsForQuestion('Which fruits are red?');
    expect(set.has('apple')).toBe(true);
    expect(set.has('strawberry')).toBe(true);
    // Original casing was 'Apple' / 'Strawberry'; simple norm lowercases.
    expect(set.has('Apple')).toBe(false);
  });

  it('does NOT HTML-strip option text (caller responsibility)', () => {
    // If options contained HTML, the returned Set would carry it through
    // as-is. This contract test ensures that a future consumer comparing
    // against HTML-aware-normalized live texts WILL see mismatches.
    // (The fixture's options are plain text, so we assert through the
    // documented behavior of norm(): no HTML processing.)
    const set = service.getPristineCorrectTextsForQuestion('What is <code>2+2</code>?');
    expect(set.size).toBe(1);
    expect(set.has('4')).toBe(true);
  });

  // ── count helper ────────────────────────────────────────────

  it('getPristineCorrectCountForQuestion returns 1 for single-answer question', () => {
    expect(service.getPristineCorrectCountForQuestion('What is <code>2+2</code>?')).toBe(1);
  });

  it('getPristineCorrectCountForQuestion returns >1 for multi-answer question', () => {
    expect(service.getPristineCorrectCountForQuestion('Which fruits are red?')).toBe(2);
  });

  it('getPristineCorrectCountForQuestion returns 0 for unknown question', () => {
    expect(service.getPristineCorrectCountForQuestion('Nonexistent question?')).toBe(0);
  });

  // ── option-objects helper ───────────────────────────────────

  it('getPristineCorrectOptionsForQuestion returns full Option[] of correct options', () => {
    const opts = service.getPristineCorrectOptionsForQuestion('Which fruits are red?');
    expect(opts.length).toBe(2);
    expect(opts.map((o: any) => o.text).sort()).toEqual(['Apple', 'Strawberry']);
    // Returned options are the original objects (NOT clones, NOT normed).
    expect((opts[0] as any).correct).toBe(true);
  });

  // ── edge cases ──────────────────────────────────────────────

  it('returns empty results for null / undefined / empty inputs without throwing', () => {
    expect(service.getPristineCorrectTextsForQuestion(null).size).toBe(0);
    expect(service.getPristineCorrectTextsForQuestion(undefined).size).toBe(0);
    expect(service.getPristineCorrectTextsForQuestion('').size).toBe(0);
    expect(service.getPristineCorrectCountForQuestion(null)).toBe(0);
    expect(service.getPristineCorrectOptionsForQuestion(null).length).toBe(0);
  });

  // ── memoization contract ────────────────────────────────────

  it('memoizes the correct-texts Set per questionText (same reference on repeat lookup)', () => {
    const first = service.getPristineCorrectTextsForQuestion('Which fruits are red?');
    const second = service.getPristineCorrectTextsForQuestion('Which fruits are red?');
    expect(second).toBe(first);
  });

  it('memoizes the correct-options Option[] per questionText (same reference on repeat lookup)', () => {
    const first = service.getPristineCorrectOptionsForQuestion('Which fruits are red?');
    const second = service.getPristineCorrectOptionsForQuestion('Which fruits are red?');
    expect(second).toBe(first);
  });
});
