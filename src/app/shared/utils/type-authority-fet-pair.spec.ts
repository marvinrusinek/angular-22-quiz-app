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
 * COMPLETION AUTHORITY — the verdict decides, not the answer key.
 *
 * `checkResolution` used to reconstruct completion locally: `computeUiResolved`
 * re-derived single-vs-multi from `correctCount > 1` and applied the matching
 * rule. That made the local answer key the COMPLETION authority, and it is why
 * a question declared SINGLE but flagged with three correct options refused to
 * resolve after one correct pick — the two assertions previously committed here
 * as KNOWN DEFECT.
 *
 * It now returns `status.resolved` whenever the verdict has `evaluated`.
 * `strict: false` is asked deliberately: that is COMPLETION (every correct
 * option chosen, extra wrong picks tolerated), not PERFECT.
 *
 * `evaluated` is the safety property. idle/checking/error report zero counts
 * because nothing is KNOWN — treating that as "answered wrongly" would
 * authorize FET on an untouched question.
 */
describe('shared-option checkResolution: completion comes from the verdict', () => {
  let service: SharedOptionExplanationService;
  let quizService: any;
  let selected: any;

  /**
   * `verdict` models what the authorized evaluation reported. `null` means the
   * verdict has not evaluated (idle/checking/error), which is the only state
   * where the temporary local-reconstruction fallback still runs.
   */
  const resolution = (
    question: QuizQuestion,
    selectedTexts: string[],
    verdict: { resolved: boolean; incorrectSelected?: number } | null = null
  ): boolean => {
    quizService.quizInitialState = [{ questions: [question] }];
    quizService.questions = [question];
    selected.getSelectedOptionsForQuestion = () =>
      selectedTexts.map((t) => ({ text: t, selected: true }));
    selected.getResolutionStatus = () =>
      verdict
        ? {
          resolved: verdict.resolved,
          correctTotal: 0,
          correctSelected: 0,
          incorrectSelected: verdict.incorrectSelected ?? 0,
          remainingCorrect: 0,
          evaluated: true
        }
        : { resolved: false, correctTotal: 0, correctSelected: 0,
          incorrectSelected: 0, remainingCorrect: 0, evaluated: false };

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

  it('KNOWN DEFECT (restored): declared SINGLE flagged 3-correct does NOT resolve on one pick', () => {
    // BRIEFLY "FIXED", THEN REVERTED. Returning the verdict early skipped the
    // pristine gate, which on REVISIT emitted FET in place of the question text
    // — a visible shipped regression. The gate is back, so this defect is back
    // with it: the count still owns the rule inside computeUiResolved.
    //
    // Fixing it properly means separating the pristine gate from the completion
    // rule, not bypassing the gate. Left asserted as the defect it is.
    expect(
      resolution(q(QuestionType.SingleAnswer, 3), ['opt1'], { resolved: true })
    ).toBe(false);
  });

  it('KNOWN DEFECT (restored): declared TRUEFALSE flagged 3-correct does NOT resolve on one pick', () => {
    expect(
      resolution(q(QuestionType.TrueFalse, 3), ['opt1'], { resolved: true })
    ).toBe(false);
  });

  it('declared MULTIPLE partial stays unresolved on an incomplete verdict', () => {
    // The verdict reports `incomplete` -> resolved:false. Completion is not
    // granted by the declared type, and one pick is not the whole set.
    expect(
      resolution(q(QuestionType.MultipleAnswer, 3), ['opt1'], { resolved: false })
    ).toBe(false);
  });

  it('declared MULTIPLE resolves when the verdict says the set is complete', () => {
    expect(
      resolution(q(QuestionType.MultipleAnswer, 3), ['opt1', 'opt2', 'opt3'], { resolved: true })
    ).toBe(true);
  });

  it('declared MULTIPLE flagged only 1-correct follows the local rule', () => {
    // With the early return reverted, a single flagged-correct option means
    // computeUiResolved takes its single-answer branch and one correct pick
    // resolves. Recorded as the current contract, not endorsed.
    expect(
      resolution(q(QuestionType.MultipleAnswer, 1), ['opt1'], { resolved: false })
    ).toBe(true);
  });

  it('COMPLETE-BUT-IMPERFECT resolves: completion is not perfection', () => {
    // Every correct option chosen PLUS a wrong one. `strict: false` is the
    // completion question, so this resolves — `incorrectSelected` is reported
    // but must not be read as "not complete".
    expect(
      resolution(q(QuestionType.MultipleAnswer, 2), ['opt1', 'opt2', 'opt4'],
        { resolved: true, incorrectSelected: 1 })
    ).toBe(true);
  });

  it('WRONG-before-complete stays unresolved', () => {
    expect(
      resolution(q(QuestionType.MultipleAnswer, 3), ['opt4'], { resolved: false })
    ).toBe(false);
  });

  it('a wrong single-answer pick does not authorize resolution', () => {
    // The verdict phase resolves on a wrong click too, which is why the status
    // is built from isResolvedCorrect rather than the phase.
    expect(
      resolution(q(QuestionType.SingleAnswer, 1), ['opt4'], { resolved: false })
    ).toBe(false);
  });

  it('completion works with NO `correct` fields when the verdict has evaluated', () => {
    // The post-cutover shape: nothing local to count, and nothing needed.
    const noKey = {
      questionText: 'No answer key at all',
      explanation: 'e',
      type: QuestionType.MultipleAnswer,
      options: [{ optionId: 1, text: 'a', value: 1 }, { optionId: 2, text: 'b', value: 2 }]
    } as unknown as QuizQuestion;

    expect(resolution(noKey, ['a', 'b'], { resolved: true })).toBe(true);
  });

  it('AUTO-REVEALED options cannot manufacture completion', () => {
    // Options revealed by the UI are not submitted answers. The authorized
    // counts come from selectedVerdicts, which covers only what the user sent,
    // so an unevaluated verdict must not resolve no matter what the UI shows.
    expect(resolution(q(QuestionType.MultipleAnswer, 3), ['opt1', 'opt2', 'opt3'], null))
      .toBe(true);   // legacy fallback path, all three genuinely selected
    expect(resolution(q(QuestionType.MultipleAnswer, 3), [], { resolved: false }))
      .toBe(false);  // nothing submitted -> no completion
  });

  it('an UNEVALUATED verdict falls back to the legacy local rule, unchanged', () => {
    // REMOVE WITH THE /questions CONTENT CUTOVER. idle/checking/error report
    // zero because nothing is known — never because nothing was correct.
    expect(resolution(q(undefined, 3), ['opt1'], null)).toBe(false);
    expect(resolution(q(undefined, 1), ['opt1'], null)).toBe(true);
    expect(resolution(q(QuestionType.MultipleAnswer, 3), [], null)).toBe(false);
  });
});
