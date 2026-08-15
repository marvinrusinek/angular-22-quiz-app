import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { of, Subject } from 'rxjs';

import { QuestionType } from '../models/question-type.enum';
import type { QuizQuestion } from '../models/QuizQuestion.model';

import { OptionClickHandlerService } from '../services/options/engine/option-click-handler.service';
import { SharedOptionBindingService } from '../services/options/engine/shared-option-binding.service';
import { SocOptionUiService } from '../services/options/engine/soc-option-ui.service';
import { QuizService } from '../services/data/quiz.service';
import { API_BASE_URL } from '../tokens/api-base-url.token';

/**
 * CLASS C GROUP 1 — CARDINALITY IS NO LONGER A TYPE ORACLE.
 *
 * Unlike Class B, these sites never read `question.type` at all: they OR a
 * count against a MODE INPUT (`comp.isMultiMode`, `comp.type === 'multiple'`,
 * `quizService.multipleAnswer`). The count WAS the type oracle, which means
 * question type stops working the moment the answer key leaves the browser.
 *
 * Every fixture below makes the declared type and the bank DISAGREE. A fixture
 * where they agree proves nothing — it passes against the old code too.
 */

// jsdom has no structuredClone; QuizService clones the bank at construction.
if (typeof (globalThis as any).structuredClone !== 'function') {
  (globalThis as any).structuredClone = (v: unknown) => JSON.parse(JSON.stringify(v));
}

/**
 * The QuizService surface these services touch at construction. Collaborators
 * (SelectedOptionService) subscribe to quizReset$ in their constructor, so the
 * stub needs the streams as well as the data.
 */
const quizServiceStub = () => ({
  isShuffleEnabled: jest.fn(() => false),
  shuffledQuestions: [] as QuizQuestion[],
  questions: [] as QuizQuestion[],
  multipleAnswer: false,
  quizInitialState: [],
  quizReset$: new Subject<void>(),
  questions$: of([]),
  currentQuestion$: of(null),
  currentQuestionIndex: 0,
  getCurrentQuestionIndex: () => 0,
  isMultiAnswerComplete: jest.fn(() => false),
  getQuestionsInDisplayOrder: jest.fn(function (this: any) { return this.questions; })
});

const q = (
  type: QuestionType | undefined,
  correctCount: number,
  questionText = 'Which of these apply?'
): QuizQuestion => ({
  questionText,
  explanation: 'e',
  type,
  options: Array.from({ length: 4 }, (_, i) => ({
    optionId: i + 1,
    text: `opt${i + 1}`,
    value: i + 1,
    correct: i < correctCount
  }))
} as unknown as QuizQuestion);

// ══════════════════════════════════════════════════════════════════════
// option-click-handler — detectMultiMode
// ══════════════════════════════════════════════════════════════════════

describe('detectMultiMode: declared type beats both the count AND the text heuristic', () => {
  let handler: OptionClickHandlerService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: 'https://api.test/api' },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } }
      ]
    });
    handler = TestBed.inject(OptionClickHandlerService);
  });

  it('declared MULTIPLE stays multi even when the bank flags only one correct', () => {
    expect(handler.detectMultiMode(q(QuestionType.MultipleAnswer, 1), 'single')).toBe(true);
  });

  it('declared MULTIPLE stays multi when the bank flags NOTHING correct', () => {
    // The shape the API returns once the answer key stops shipping.
    expect(handler.detectMultiMode(q(QuestionType.MultipleAnswer, 0), 'single')).toBe(true);
  });

  it('declared SINGLE stays single even when the bank flags three correct', () => {
    // THE REGRESSION THIS PINS — the count used to promote unconditionally.
    expect(handler.detectMultiMode(q(QuestionType.SingleAnswer, 3), 'single')).toBe(false);
  });

  it('declared TRUEFALSE is single-selection despite a malformed answer key', () => {
    expect(handler.detectMultiMode(q(QuestionType.TrueFalse, 3), 'single')).toBe(false);
  });

  it('declared SINGLE beats the "select all that apply" TEXT heuristic', () => {
    // The wording heuristic is a second answer-key-era proxy; a declared type
    // retires it too.
    const misleading = q(QuestionType.SingleAnswer, 1, 'Select all that apply');
    expect(handler.detectMultiMode(misleading, 'single')).toBe(false);
  });

  it('UNDECLARED keeps the legacy fallback: text heuristic, then count, then input', () => {
    // REMOVE WITH THE /questions CONTENT CUTOVER. Unknown is not "single".
    expect(handler.detectMultiMode(q(undefined, 1, 'Select all that apply'), 'single')).toBe(true);
    expect(handler.detectMultiMode(q(undefined, 3), 'single')).toBe(true);
    expect(handler.detectMultiMode(q(undefined, 1), 'single')).toBe(false);
    expect(handler.detectMultiMode(q(undefined, 0), 'multiple')).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════
// option-click-handler — resolveEffectiveMulti / correctOptionStaysEnabled
// ══════════════════════════════════════════════════════════════════════

describe('option-click-handler disable logic: declared type beats the count', () => {
  let handler: OptionClickHandlerService;
  let quizService: any;

  const effectiveMulti = (isMultiMode: boolean, qIndex: number): boolean =>
    (handler as any).resolveEffectiveMulti(isMultiMode, qIndex);

  const isMultiFromData = (question: QuizQuestion): boolean => {
    // correctOptionStaysEnabled returns false (stay enabled) for single-answer,
    // and consults completion for multi. isMultiAnswerComplete is stubbed false,
    // so BOTH branches return false — we assert the branch taken instead.
    const spy = jest.spyOn(quizService, 'isMultiAnswerComplete');
    (handler as any).correctOptionStaysEnabled(question.options![0], 0, false);
    const consultedCompletion = spy.mock.calls.length > 0;
    spy.mockRestore();
    return consultedCompletion;   // only the MULTI branch asks about completion
  };

  beforeEach(() => {
    quizService = quizServiceStub();

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: 'https://api.test/api' },
        { provide: QuizService, useValue: quizService },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } }
      ]
    });
    handler = TestBed.inject(OptionClickHandlerService);
  });

  it('resolveEffectiveMulti does NOT promote a declared single flagged 3 correct', () => {
    quizService.questions = [q(QuestionType.SingleAnswer, 3)];
    expect(effectiveMulti(false, 0)).toBe(false);
  });

  it('resolveEffectiveMulti DOES resolve a declared multiple flagged 1 correct', () => {
    quizService.questions = [q(QuestionType.MultipleAnswer, 1)];
    expect(effectiveMulti(false, 0)).toBe(true);
  });

  it('resolveEffectiveMulti keeps a declared trueFalse single', () => {
    quizService.questions = [q(QuestionType.TrueFalse, 3)];
    expect(effectiveMulti(false, 0)).toBe(false);
  });

  it('resolveEffectiveMulti falls back to the count when UNDECLARED', () => {
    quizService.questions = [q(undefined, 3)];
    expect(effectiveMulti(false, 0)).toBe(true);
  });

  it('resolveEffectiveMulti reads the DISPLAYED question under shuffle', () => {
    // Canonical slot 0 is SINGLE; the question shown at display index 0 is
    // MULTIPLE. `questions` is a getter returning shuffledQuestions while
    // shuffle is active, which is why indexing it here is identity-safe.
    quizService.isShuffleEnabled = jest.fn(() => true);
    quizService.shuffledQuestions = [q(QuestionType.MultipleAnswer, 1, 'displayed')];
    quizService.questions = quizService.shuffledQuestions;
    quizService.getQuestionsInDisplayOrder = jest.fn(() => quizService.shuffledQuestions);

    expect(effectiveMulti(false, 0)).toBe(true);
  });

  it('correctOptionStaysEnabled takes the SINGLE branch for a declared single flagged 3 correct', () => {
    const question = q(QuestionType.SingleAnswer, 3);
    quizService.questions = [question];
    expect(isMultiFromData(question)).toBe(false);
  });

  it('correctOptionStaysEnabled takes the MULTI branch for a declared multiple flagged 1 correct', () => {
    const question = q(QuestionType.MultipleAnswer, 1);
    quizService.questions = [question];
    expect(isMultiFromData(question)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════
// soc-option-ui — handleSelection single-vs-multi click semantics
// ══════════════════════════════════════════════════════════════════════

describe('soc-option-ui handleSelection: declared type decides clear-vs-toggle', () => {
  let service: SocOptionUiService;

  /** Returns true when the click TOGGLED (multi) rather than CLEARED (single). */
  const clickBehavesMulti = (question: QuizQuestion): boolean => {
    const optionsToDisplay = (question.options ?? []).map((o) => ({ ...o, selected: false }));
    // Pre-select a DIFFERENT option: single-answer must clear it, multi must keep it.
    optionsToDisplay[1].selected = true;

    const comp: any = {
      currentQuestion: () => question,
      config: () => ({ type: 'single' }),
      type: 'single',
      optionsToDisplay,
      optionBindings: () => optionsToDisplay.map((o) => ({ option: o, isSelected: o.selected })),
      selectedOption: { set: () => {} },
      selectedOptions: new Set<number>(),
      getActiveQuestionIndex: () => 0,
      _multiSelectByQuestion: new Map<number, Set<number>>(),
      showFeedbackForOption: {},
      selectedOptionHistory: []
    };

    service.handleSelection(comp, optionsToDisplay[0] as any, 0, 1);
    return optionsToDisplay[1].selected === true;
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: 'https://api.test/api' },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } }
      ]
    });
    service = TestBed.inject(SocOptionUiService);
  });

  it('declared SINGLE clears the other option even when the bank flags 3 correct', () => {
    // Promoted by the count, the click toggled and left a stale selection.
    expect(clickBehavesMulti(q(QuestionType.SingleAnswer, 3))).toBe(false);
  });

  it('declared MULTIPLE preserves the other option even when the bank flags 1 correct', () => {
    expect(clickBehavesMulti(q(QuestionType.MultipleAnswer, 1))).toBe(true);
  });

  it('declared TRUEFALSE clears, despite a malformed answer key', () => {
    expect(clickBehavesMulti(q(QuestionType.TrueFalse, 3))).toBe(false);
  });

  it('UNDECLARED still follows the counted fallback', () => {
    expect(clickBehavesMulti(q(undefined, 3))).toBe(true);
    expect(clickBehavesMulti(q(undefined, 1))).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// shared-option-binding — resolveBuildIsMulti
// ══════════════════════════════════════════════════════════════════════

describe('shared-option-binding resolveBuildIsMulti: declared type beats the count', () => {
  let service: SharedOptionBindingService;
  let quizService: any;

  const buildIsMulti = (comp: any, qIndex: number): boolean =>
    (service as any).resolveBuildIsMulti(comp, qIndex);

  beforeEach(() => {
    quizService = quizServiceStub();

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: 'https://api.test/api' },
        { provide: QuizService, useValue: quizService },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } }
      ]
    });
    service = TestBed.inject(SharedOptionBindingService);
  });

  it('declared SINGLE is not promoted by 3 correct flags', () => {
    quizService.questions = [q(QuestionType.SingleAnswer, 3)];
    expect(buildIsMulti({ isMultiMode: false }, 0)).toBe(false);
  });

  it('declared SINGLE is not promoted by the quiz-level multipleAnswer flag', () => {
    quizService.questions = [q(QuestionType.SingleAnswer, 1)];
    quizService.multipleAnswer = true;
    expect(buildIsMulti({ isMultiMode: false }, 0)).toBe(false);
  });

  it('declared MULTIPLE resolves multi even when the bank flags 1 correct', () => {
    quizService.questions = [q(QuestionType.MultipleAnswer, 1)];
    expect(buildIsMulti({ isMultiMode: false }, 0)).toBe(true);
  });

  it('declared TRUEFALSE stays single', () => {
    quizService.questions = [q(QuestionType.TrueFalse, 3)];
    expect(buildIsMulti({ isMultiMode: false }, 0)).toBe(false);
  });

  it('UNDECLARED keeps the counted / isMultiMode / multipleAnswer fallback', () => {
    quizService.questions = [q(undefined, 3)];
    expect(buildIsMulti({ isMultiMode: false }, 0)).toBe(true);

    quizService.questions = [q(undefined, 1)];
    expect(buildIsMulti({ isMultiMode: false }, 0)).toBe(false);
    expect(buildIsMulti({ isMultiMode: true }, 0)).toBe(true);
  });

  it('reads the DISPLAYED question under shuffle', () => {
    // Display index 0 shows a declared SINGLE; the canonical first question is
    // MULTIPLE. Resolving against the canonical slot would return true.
    quizService.isShuffleEnabled = jest.fn(() => true);
    quizService.shuffledQuestions = [
      q(QuestionType.SingleAnswer, 3, 'displayed first'),
      q(QuestionType.MultipleAnswer, 2, 'canonical first')
    ];
    quizService.questions = quizService.shuffledQuestions;

    expect(buildIsMulti({ isMultiMode: false }, 0)).toBe(false);
  });
});
