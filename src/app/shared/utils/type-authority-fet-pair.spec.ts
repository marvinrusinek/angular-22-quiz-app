import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { QuestionType } from '../models/question-type.enum';
import type { QuizQuestion } from '../models/QuizQuestion.model';

import { QqcExplanationDisplayService } from '../services/features/qqc/qqc-explanation-display.service';
import { SharedOptionExplanationService } from '../services/features/shared-option/shared-option-explanation.service';
import { QuizService } from '../services/data/quiz.service';
import { SelectedOptionService } from '../services/state/selectedoption.service';
import { API_BASE_URL } from '../tokens/api-base-url.token';

/**
 * FET PAIR — CARDINALITY IS NO LONGER THE TYPE ORACLE FOR FET BRANCHING.
 *
 * Both sites asked "is this multi-answer?" by counting `correct` flags, then
 * used the answer to pick which FET rule applies:
 *
 *   single -> emit the explanation now
 *   multi  -> wait until every correct answer is selected
 *
 * Only the CLASSIFICATION moved to the declared type. The COMPLETION half is
 * deliberately untouched and still reads the bank, because "what kind of
 * question is this" and "has the user finished it" are different questions and
 * a declared type can only answer the first.
 *
 * These tests therefore prove BOTH halves: that classification now follows the
 * declared type, AND that the partial/complete/wrong FET authorization rules
 * behave exactly as before.
 */

// jsdom has no structuredClone; QuizService clones the bank at construction.
if (typeof (globalThis as any).structuredClone !== 'function') {
  (globalThis as any).structuredClone = (v: unknown) => JSON.parse(JSON.stringify(v));
}

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

/** Options carrying no `correct` property at all — the post-cutover shape. */
const bare = (type: QuestionType | undefined): QuizQuestion => ({
  questionText: 'No answer key at all',
  explanation: 'e',
  type,
  options: [
    { optionId: 1, text: 'a', value: 1 },
    { optionId: 2, text: 'b', value: 2 }
  ]
} as unknown as QuizQuestion);

// ══════════════════════════════════════════════════════════════════════
// SITE 1 — qqc-explanation-display.emitExplanationForActiveIndex
// ══════════════════════════════════════════════════════════════════════

describe('qqc FET gate: classification declared, completion still counted', () => {
  let service: QqcExplanationDisplayService;
  let quizService: any;
  let selected: any;
  let displayed: boolean;

  /** Runs the real emit path; returns whether FET was authorized. */
  const emit = (question: QuizQuestion, selectedTexts: string[]): boolean => {
    displayed = false;
    quizService.questions = [question];
    quizService.shuffledQuestions = [];
    selected.getSelectedOptionsForQuestion = () =>
      selectedTexts.map((t) => ({ text: t, selected: true }));

    (service as any).emitExplanationForActiveIndex(question, 0, 'THE EXPLANATION');
    return displayed;
  };

  beforeEach(() => {
    quizService = {
      questions: [] as QuizQuestion[],
      shuffledQuestions: [] as QuizQuestion[],
      quizInitialState: [],
      isShuffleEnabled: jest.fn(() => false)
    };
    selected = { getSelectedOptionsForQuestion: () => [] };

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: 'https://api.test/api' },
        { provide: QuizService, useValue: quizService },
        { provide: SelectedOptionService, useValue: selected },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } }
      ]
    });
    service = TestBed.inject(QqcExplanationDisplayService);

    // Capture FET authorization without touching content supply.
    const ets: any = (service as any).explanationTextService;
    ets.setExplanationText = () => {};
    ets.setShouldDisplayExplanation = (v: boolean) => { if (v) displayed = true; };
  });

  // ── TYPE CLASSIFICATION ───────────────────────────────────────────

  it('declared SINGLE emits immediately even though the bank flags 3 correct', () => {
    // Counted as multi, this waited for all three and FET never appeared.
    expect(emit(q(QuestionType.SingleAnswer, 3), ['opt1'])).toBe(true);
  });

  it('declared MULTIPLE waits for completion even though the bank flags 1 correct', () => {
    // Counted as single, this leaked FET on the first click.
    expect(emit(q(QuestionType.MultipleAnswer, 1), [])).toBe(false);
  });

  it('declared TRUEFALSE emits immediately despite a misleading count', () => {
    expect(emit(q(QuestionType.TrueFalse, 3), ['opt1'])).toBe(true);
  });

  it('UNDECLARED keeps the legacy count fallback', () => {
    // REMOVE WITH THE /questions CONTENT CUTOVER. Unknown is not "single".
    expect(emit(q(undefined, 1), [])).toBe(true);            // counted single
    expect(emit(q(undefined, 3), ['opt1'])).toBe(false);     // counted multi, partial
  });

  it('reads the DISPLAYED question under shuffle', () => {
    // Canonical slot 0 is MULTIPLE; the question shown at display index 0 is
    // SINGLE. Resolved against the canonical slot this would withhold FET.
    const displayedQ = q(QuestionType.SingleAnswer, 3, 'displayed first');
    displayed = false;
    quizService.questions = [q(QuestionType.MultipleAnswer, 2, 'canonical first')];
    quizService.shuffledQuestions = [displayedQ];
    selected.getSelectedOptionsForQuestion = () => [{ text: 'opt1', selected: true }];

    (service as any).emitExplanationForActiveIndex(displayedQ, 0, 'THE EXPLANATION');
    expect(displayed).toBe(true);
  });

  // ── FET AUTHORIZATION — MUST BE UNCHANGED ─────────────────────────

  it('PARTIAL multi-answer is still unauthorized', () => {
    // 3 correct, only 1 selected.
    expect(emit(q(QuestionType.MultipleAnswer, 3), ['opt1'])).toBe(false);
  });

  it('COMPLETED multi-answer is still authorized', () => {
    expect(emit(q(QuestionType.MultipleAnswer, 3), ['opt1', 'opt2', 'opt3'])).toBe(true);
  });

  it('WRONG-before-complete is still unauthorized', () => {
    // A wrong pick does not complete the set, so the gate stays shut.
    expect(emit(q(QuestionType.MultipleAnswer, 3), ['opt4'])).toBe(false);
  });

  it('completion is NOT satisfied by the declared type alone', () => {
    // THE CORE SEPARATION. Declaring a question multi-answer must never be
    // read as "the user completed it" — with nothing selected, FET stays shut.
    expect(emit(q(QuestionType.MultipleAnswer, 3), [])).toBe(false);
  });

  it('a declared MULTIPLE with NO `correct` fields cannot be completed locally', () => {
    // Documents a REAL post-cutover limitation rather than hiding it: with no
    // answer key there are no correct texts to match, so the completion half
    // (still bank-based) can never say "finished". Completion authority is a
    // separate migration; this slice must not fake it with the declared type.
    expect(emit(bare(QuestionType.MultipleAnswer), ['a', 'b'])).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// SITE 2 — shared-option-explanation.checkResolution
// ══════════════════════════════════════════════════════════════════════

/**
 * DEFERRED — CHARACTERIZATION, NOT APPROVAL.
 *
 * This site LOOKED like the same decision as the one above, and the census
 * paired them. It is not, and these tests are the evidence.
 *
 * `checkResolution` computes `isMultiAnswer` from the count, but the branch
 * that actually decides FET lives one level down in `computeUiResolved`:
 *
 *     if (correctCount > 1) return correctSelected >= correctCount;
 *     return correctSelected >= 1;
 *
 * That is a SECOND, independent single-vs-multi decision embedded inside the
 * COMPLETION calculation. Migrating only the outer flag leaves a split brain —
 * classification reporting "single" while the rule applied is still "multi" —
 * and migrating the inner one changes completion authorization, which this
 * slice is explicitly not permitted to do.
 *
 * So these tests pin the CURRENT behaviour, including the part that is wrong:
 * a declared single-answer question whose bank flags three correct still
 * refuses to resolve on one correct pick. That is the defect a future
 * completion-authority slice has to fix. Locking it here means that slice
 * cannot land silently.
 */
describe('shared-option checkResolution: DEFERRED — count still owns the rule', () => {
  let service: SharedOptionExplanationService;
  let quizService: any;
  let selected: any;

  const resolution = (question: QuizQuestion, selectedTexts: string[]): boolean => {
    quizService.quizInitialState = [{ questions: [question] }];
    quizService.questions = [question];
    selected.getSelectedOptionsForQuestion = () =>
      selectedTexts.map((t) => ({ text: t, selected: true }));

    return (service as any).checkResolution({
      resolvedIndex: 0,
      question,
      currentQuestion: question,
      quizId: 'quiz-1',
      optionBindings: (question.options ?? []).map((o: any) => ({
        option: { ...o, selected: selectedTexts.includes(o.text) },
        isSelected: selectedTexts.includes(o.text)
      })),
      optionsToDisplay: question.options,
      isMultiMode: false
    });
  };

  beforeEach(() => {
    quizService = {
      questions: [] as QuizQuestion[],
      shuffledQuestions: [] as QuizQuestion[],
      quizInitialState: [] as any[],
      multipleAnswer: false,
      isShuffleEnabled: jest.fn(() => false),
      getQuestionsInDisplayOrder: jest.fn(function (this: any) { return quizService.questions; })
    };
    selected = {
      getSelectedOptionsForQuestion: () => [],
      getResolutionStatus: () => ({ resolved: false })
    };

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: 'https://api.test/api' },
        { provide: QuizService, useValue: quizService },
        { provide: SelectedOptionService, useValue: selected },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } }
      ]
    });
    service = TestBed.inject(SharedOptionExplanationService);
  });

  it('KNOWN DEFECT: a declared SINGLE flagged 3-correct does NOT resolve on one pick', () => {
    // The count still owns the rule inside computeUiResolved, so the declared
    // type is ignored. Asserting `false` records the bug rather than hiding it;
    // flip this to `true` in the completion-authority slice.
    expect(resolution(q(QuestionType.SingleAnswer, 3), ['opt1'])).toBe(false);
  });

  it('declared MULTIPLE still requires every correct pick', () => {
    const question = q(QuestionType.MultipleAnswer, 3);
    expect(resolution(question, ['opt1'])).toBe(false);
    expect(resolution(question, ['opt1', 'opt2', 'opt3'])).toBe(true);
  });

  it('KNOWN DEFECT: a declared TRUEFALSE flagged 3-correct does NOT resolve on one pick', () => {
    expect(resolution(q(QuestionType.TrueFalse, 3), ['opt1'])).toBe(false);
  });

  it('a well-formed declared SINGLE resolves on one pick, as it always did', () => {
    // The count and the declared type AGREE here, which is why this passes and
    // the two above do not — the defect is exactly the disagreement case.
    expect(resolution(q(QuestionType.SingleAnswer, 1), ['opt1'])).toBe(true);
  });

  it('UNDECLARED keeps the legacy count fallback', () => {
    expect(resolution(q(undefined, 3), ['opt1'])).toBe(false);
    expect(resolution(q(undefined, 1), ['opt1'])).toBe(true);
  });

  it('WRONG-before-complete stays unresolved', () => {
    expect(resolution(q(QuestionType.MultipleAnswer, 3), ['opt4'])).toBe(false);
  });

  it('nothing selected stays unresolved for a declared multiple', () => {
    // Declared type is not completion authority.
    expect(resolution(q(QuestionType.MultipleAnswer, 3), [])).toBe(false);
  });
});
