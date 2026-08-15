import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { QuestionType } from '../models/question-type.enum';
import type { Option } from '../models/Option.model';
import type { QuizQuestion } from '../models/QuizQuestion.model';
import type { SelectedOption } from '../models/SelectedOption.model';

import { QqcOptionSelectionService } from '../services/features/qqc/qqc-option-selection.service';
import { QuizService } from '../services/data/quiz.service';
import { SelectedOptionService } from '../services/state/selectedoption.service';
import { ExplanationTextService } from '../services/features/explanation/explanation-text.service';
import { API_BASE_URL } from '../tokens/api-base-url.token';
import { answerStateStub } from '../testing/answer-state-stub';

/**
 * QQC OPTION SELECTION — THE FET EMISSION GATE IS A TYPE DECISION.
 *
 * `performSelectOption` withholds explanation emission for multi-answer
 * questions (they must wait for the whole set) and emits immediately for
 * single-answer ones. Which branch applies was decided by counting `correct`
 * flags, so a declared SINGLE question the bank flagged twice was treated as
 * multi and never emitted its explanation from this path at all.
 *
 * Only the CLASSIFICATION moved. This path consults neither completion nor
 * correctness — it never did — and this change adds no such gate. The
 * explanation TEXT is fetched and returned regardless of the branch.
 *
 * Every fixture makes the declared type and the bank DISAGREE; one where they
 * agree passes against the old code too.
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

describe('qqc option selection: FET emission branch follows the DECLARED type', () => {
  let service: QqcOptionSelectionService;
  let quizService: any;
  let explanationEmitted: boolean;
  let displayedFlagSet: boolean;
  let returnedText: string | undefined;

  /**
   * Runs the REAL performSelectOption and reports whether the single-answer
   * branch fired (explanation emitted) plus what text came back.
   */
  const select = async (
    question: QuizQuestion,
    canonicalAtIndex?: QuizQuestion
  ): Promise<boolean> => {
    explanationEmitted = false;
    displayedFlagSet = false;
    returnedText = undefined;

    // `questions` is the DISPLAY-ordered source in production. When a canonical
    // stand-in is supplied it is placed here to prove the lookup is display-safe.
    quizService.questions = [canonicalAtIndex ?? question];

    const result = await service.performSelectOption({
      currentQuestion: question,
      option: { optionId: 1, text: 'opt1', value: 1 } as SelectedOption,
      optionIndex: 0,
      currentQuestionIndex: 0,
      isMultipleAnswer: false,
      optionsToDisplay: question.options as Option[],
      selectedOptionsCount: 1,
      getExplanationText: async () => 'THE EXPLANATION'
    });

    returnedText = result?.explanationText;
    return explanationEmitted;
  };

  beforeEach(() => {
    // answerStateStub supplies the completion/perfect/resolved surface over real
    // Maps. Nothing in this path reads it — which is the point: if a future edit
    // starts consulting completion here, it gets the shared stub's semantics
    // rather than an ad-hoc one, and the omission shows up as a real failure.
    quizService = {
      questions: [] as QuizQuestion[],
      shuffledQuestions: [] as QuizQuestion[],
      quizInitialState: [],
      isShuffleEnabled: jest.fn(() => false),
      getCurrentQuestionIndex: () => 0,
      setCurrentQuestion: jest.fn(),
      ...answerStateStub()
    };

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: 'https://api.test/api' },
        { provide: QuizService, useValue: quizService },
        {
          provide: SelectedOptionService,
          useValue: {
            // stopTimer$ / selectedOptionsMap match the stub shape the existing
            // engine specs use — TimerService subscribes at construction.
            stopTimer$: of(undefined),
            selectedOptionsMap: new Map(),
            uiSelectedTextsForQuestion: () => new Set<string>(),
            setSelectedOption: jest.fn(),
            selectOption: jest.fn(async () => {}),
            updateSelectedOptions: jest.fn(),
            overlaySelectedByIdentity: (_c: Option[], ui: Option[]) => ui
          }
        },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } }
      ]
    });
    service = TestBed.inject(QqcOptionSelectionService);

    // Capture FET emission without touching content supply.
    const ets: any = TestBed.inject(ExplanationTextService);
    ets.setExplanationText = () => { explanationEmitted = true; };
    ets.setIsExplanationTextDisplayed = () => { displayedFlagSet = true; };
    ets.updateExplanationText = () => {};
  });

  // ── TYPE CLASSIFICATION ───────────────────────────────────────────

  it('declared SINGLE emits immediately even though the bank flags 3 correct', async () => {
    // THE REGRESSION THIS PINS — counted as multi, this never emitted at all.
    expect(await select(q(QuestionType.SingleAnswer, 3))).toBe(true);
    expect(displayedFlagSet).toBe(true);
  });

  it('declared MULTIPLE withholds emission even though the bank flags 1 correct', async () => {
    // Counted as single, this leaked FET on the very first click.
    expect(await select(q(QuestionType.MultipleAnswer, 1))).toBe(false);
    expect(displayedFlagSet).toBe(false);
  });

  it('declared TRUEFALSE emits immediately despite a misleading count', async () => {
    // trueFalse is single-SELECTION; the declared type is not rewritten.
    expect(await select(q(QuestionType.TrueFalse, 3))).toBe(true);
  });

  it('declared MULTIPLE withholds emission with NO `correct` fields at all', async () => {
    const bare = {
      questionText: 'No answer key at all',
      explanation: 'e',
      type: QuestionType.MultipleAnswer,
      options: [{ optionId: 1, text: 'a', value: 1 }, { optionId: 2, text: 'b', value: 2 }]
    } as unknown as QuizQuestion;

    expect(await select(bare)).toBe(false);
  });

  it('UNDECLARED keeps the legacy count fallback', async () => {
    // REMOVE WITH THE /questions CONTENT CUTOVER. Unknown is not "single".
    expect(await select(q(undefined, 3))).toBe(false);   // counted multi
    expect(await select(q(undefined, 1))).toBe(true);    // counted single
  });

  it('reads the DISPLAYED question, not a canonical stand-in, under shuffle', async () => {
    // The question at the looked-up slot is declared MULTIPLE while the question
    // actually being answered is declared SINGLE. `questions` is display-ordered
    // in production, so the slot IS the displayed question — this pins that the
    // resolved type belongs to the question on screen either way.
    const displayed = q(QuestionType.SingleAnswer, 3, 'displayed');
    quizService.isShuffleEnabled = jest.fn(() => true);
    quizService.shuffledQuestions = [displayed];

    expect(await select(displayed, displayed)).toBe(true);
  });

  // ── CONTENT AND NON-TYPE CONCERNS — UNCHANGED ─────────────────────

  it('explanation TEXT is returned on both branches', async () => {
    // Content supply is not gated by type; only EMISSION is. A multi-answer
    // question still carries its explanation back to the caller.
    await select(q(QuestionType.MultipleAnswer, 3));
    expect(returnedText).toBe('THE EXPLANATION');

    await select(q(QuestionType.SingleAnswer, 1));
    expect(returnedText).toBe('THE EXPLANATION');
  });

  it('does NOT gate emission on whether the pick was correct', async () => {
    // Documents existing behaviour rather than changing it: this path has never
    // consulted correctness, and this slice did not add a correctness gate.
    // Selecting opt1 on a single-answer question whose ONLY correct option is
    // opt4 still emits, exactly as before.
    const wrongPickable = q(QuestionType.SingleAnswer, 0);
    (wrongPickable.options as any)[3].correct = true;

    expect(await select(wrongPickable)).toBe(true);
  });
});
