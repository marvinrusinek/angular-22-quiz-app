import { QuestionType } from '../models/question-type.enum';
import { buildHeadingInputs } from './heading-inputs';
import { deriveHeadingHtml, shouldShowFet } from './heading-model';

/**
 * INCORRECT / INCOMPLETE ATTEMPTS MUST NOT EARN THE FET.
 *
 * ── The regression this pins ──────────────────────────────────────
 *
 * The refresh-restoration fix (`verdictEarnedReveal`, added so a genuine
 * timeout's FET survives a page reload) was first computed as:
 *
 *     !!verdict && (verdict.phase === 'resolved' || verdict.phase === 'expired')
 *
 * That reads `phase`, not correctness. But `checkAnswer` (backend) resolves a
 * single/trueFalse question on its FIRST valid submission — "any valid
 * non-empty submission is terminal: the shipped behaviour reveals the answer
 * on the first click, right or wrong" (answer-check.ts). So `phase:
 * 'resolved'` with `isResolvedCorrect: false` is the NORMAL state for a wrong
 * single-answer pick, and the reads above being unaware of that turned every
 * wrong pick into an immediate FET reveal — regressing the long-established
 * "keep trying until you get it right" contract for single-answer questions.
 *
 * ── The fix ────────────────────────────────────────────────────────
 *
 * `verdictEarnedReveal` (heading-inputs.ts) is now:
 *
 *     !!verdict && (verdict.phase === 'expired' || verdictComplete === true)
 *
 * `verdictComplete` is `allCorrectSelectedFromVerdict(verdict)` — the SAME
 * authority multi-answer completion already used before this fix existed,
 * not a new parallel boolean: for `resolved` it is `isResolvedCorrect ===
 * true` (false for a wrong single pick, true for a correct one, and true for
 * multi-answer since the backend only resolves multi once the correct subset
 * is met); for `incomplete` it is `remainingCorrectCount === 0`. `expired` is
 * ORed in separately because a genuine timeout always earns the reveal,
 * whatever was or wasn't selected.
 *
 * These tests exercise the full `buildHeadingInputs` → `shouldShowFet` path
 * with realistic verdict shapes — this is the level the actual bug lived at;
 * `heading-model.spec.ts` only pins the CONTRACT once the boolean already
 * exists, which is why it did not catch this.
 */

const IDX = 0;
const QUESTION = "What is the primary job of Angular's change detection?";
const RIGHT_TEXT = 'Keep the view (DOM) in sync with the data model.';
const WRONG_TEXT = 'Compile TypeScript into JavaScript.';
const OTHER_CORRECT_TEXT = 'Bundle the application for production.';
const AUTHORIZED_EXPLANATION = 'Option 1 is correct because it keeps the view in sync.';

interface DepsOverrides {
  questionType?: QuestionType;
  selectedOptionTexts?: string[];
  verdictPhase?: 'idle' | 'checking' | 'incomplete' | 'resolved' | 'expired' | 'error';
  isResolvedCorrect?: boolean | null;
  remainingCorrectCount?: number | null;
  selectedVerdicts?: [string, boolean][];
  correctOptionTexts?: string[];
  explanation?: string | null;
  hasInteracted?: boolean;
  isTimedOut?: boolean;
  isNavigatingToPrevious?: boolean;
  interactedThisVisit?: boolean;
}

function deps(over: DepsOverrides) {
  const question = {
    questionText: QUESTION,
    type: over.questionType ?? QuestionType.SingleAnswer,
    options: [{}, {}, {}, {}]
  };
  const selectedTexts = over.selectedOptionTexts ?? [];

  return {
    idx: IDX,
    quizService: {
      quizId: 'change-detection',
      getQuestionsInDisplayOrder: () => Object.assign([], { [IDX]: question, length: IDX + 1 }),
      questions: Object.assign([], { [IDX]: question, length: IDX + 1 }),
      isShuffleEnabled: () => false,
      shuffledQuestions: [],
      isMultiAnswerComplete: () => false
    },
    explanationTextService: {
      formattedExplanations: {},
      fetByIndex: new Map<number, string>(),
      timeoutFetByIndex: new Map<number, string>(),
      fetBypassForQuestion: new Map<number, boolean>()
    },
    timerService: {
      expiredForQuestionIndexSig: () => (over.isTimedOut ? IDX : -1),
      expiredOnArrivalSig: () => -1
    },
    selectedOptionService: {
      selectedOptionsMap: new Map([[IDX, selectedTexts.map((text) => ({ text, selected: true }))]])
    },
    quizStateService: {
      hasUserInteracted: () => over.hasInteracted === true,
      wasInteractedThisVisit: () => over.interactedThisVisit === true
    },
    quizNavigationService: { isNavigatingToPreviousSig: () => over.isNavigatingToPrevious === true },
    quizQuestionManagerService: { getNumberOfCorrectAnswersText: () => '' },
    feedbackPolicyService: { feedbackMode: () => 'immediate' },
    questionVerdictService: over.verdictPhase
      ? {
          verdictFor: () => ({
            phase: over.verdictPhase,
            selectedOptionTexts: selectedTexts,
            selectedVerdicts: new Map(over.selectedVerdicts ?? []),
            remainingCorrectCount: over.remainingCorrectCount ?? null,
            correctOptionTexts: over.correctOptionTexts ?? [],
            explanation: over.explanation ?? null,
            isResolvedCorrect: over.isResolvedCorrect ?? null
          }),
          states: () => new Map()
        }
      : undefined
  } as any;
}

const headingFor = (over: DepsOverrides): string => {
  const inputs = buildHeadingInputs(deps(over));
  return deriveHeadingHtml({ ...inputs!, optionsReady: true });
};

const showsFetFor = (over: DepsOverrides): boolean => {
  const inputs = buildHeadingInputs(deps(over));
  return shouldShowFet({ ...inputs!, optionsReady: true });
};

describe('FET eligibility: incorrect/incomplete attempts must not earn the reveal', () => {
  it('1. single wrong answer → question text remains, no FET', () => {
    const over: DepsOverrides = {
      questionType: QuestionType.SingleAnswer,
      selectedOptionTexts: [WRONG_TEXT],
      verdictPhase: 'resolved',
      isResolvedCorrect: false,
      selectedVerdicts: [[WRONG_TEXT.toLowerCase(), false]],
      correctOptionTexts: [RIGHT_TEXT],
      explanation: AUTHORIZED_EXPLANATION,
      hasInteracted: true,
      interactedThisVisit: true
    };
    expect(showsFetFor(over)).toBe(false);
    expect(headingFor(over)).toBe(QUESTION);
  });

  it('2. wrong → correct: FET only appears once the correct option is picked', () => {
    const wrongAttempt: DepsOverrides = {
      questionType: QuestionType.SingleAnswer,
      selectedOptionTexts: [WRONG_TEXT],
      verdictPhase: 'resolved',
      isResolvedCorrect: false,
      selectedVerdicts: [[WRONG_TEXT.toLowerCase(), false]],
      correctOptionTexts: [RIGHT_TEXT],
      explanation: AUTHORIZED_EXPLANATION,
      hasInteracted: true,
      interactedThisVisit: true
    };
    expect(showsFetFor(wrongAttempt)).toBe(false);

    const correctAttempt: DepsOverrides = {
      ...wrongAttempt,
      selectedOptionTexts: [RIGHT_TEXT],
      isResolvedCorrect: true,
      selectedVerdicts: [[RIGHT_TEXT.toLowerCase(), true]]
    };
    expect(showsFetFor(correctAttempt)).toBe(true);
    expect(headingFor(correctAttempt)).toBe(AUTHORIZED_EXPLANATION);
  });

  it('3. multi-answer partial-but-correct-so-far selection → no FET', () => {
    const over: DepsOverrides = {
      questionType: QuestionType.MultipleAnswer,
      selectedOptionTexts: [RIGHT_TEXT],
      verdictPhase: 'incomplete',
      selectedVerdicts: [[RIGHT_TEXT.toLowerCase(), true]],
      remainingCorrectCount: 1,
      hasInteracted: true,
      interactedThisVisit: true
    };
    expect(showsFetFor(over)).toBe(false);
    expect(headingFor(over)).toBe(QUESTION);
  });

  it('4. multi-answer selection including an incorrect option → no FET', () => {
    const over: DepsOverrides = {
      questionType: QuestionType.MultipleAnswer,
      selectedOptionTexts: [RIGHT_TEXT, WRONG_TEXT],
      verdictPhase: 'incomplete',
      selectedVerdicts: [
        [RIGHT_TEXT.toLowerCase(), true],
        [WRONG_TEXT.toLowerCase(), false]
      ],
      remainingCorrectCount: 1,
      hasInteracted: true,
      interactedThisVisit: true
    };
    expect(showsFetFor(over)).toBe(false);
    expect(headingFor(over)).toBe(QUESTION);
  });

  it('5. multi-answer complete with every correct option selected → FET', () => {
    const over: DepsOverrides = {
      questionType: QuestionType.MultipleAnswer,
      selectedOptionTexts: [RIGHT_TEXT, OTHER_CORRECT_TEXT],
      verdictPhase: 'resolved',
      isResolvedCorrect: true,
      selectedVerdicts: [
        [RIGHT_TEXT.toLowerCase(), true],
        [OTHER_CORRECT_TEXT.toLowerCase(), true]
      ],
      remainingCorrectCount: 0,
      correctOptionTexts: [RIGHT_TEXT, OTHER_CORRECT_TEXT],
      explanation: AUTHORIZED_EXPLANATION,
      hasInteracted: true,
      interactedThisVisit: true
    };
    expect(showsFetFor(over)).toBe(true);
    expect(headingFor(over)).toBe(AUTHORIZED_EXPLANATION);
  });

  it('6. genuine timeout → FET, regardless of question type or what (if anything) was selected', () => {
    const singleTimedOut: DepsOverrides = {
      questionType: QuestionType.SingleAnswer,
      verdictPhase: 'expired',
      correctOptionTexts: [RIGHT_TEXT],
      explanation: AUTHORIZED_EXPLANATION,
      isTimedOut: true
    };
    expect(showsFetFor(singleTimedOut)).toBe(true);
    expect(headingFor(singleTimedOut)).toBe(AUTHORIZED_EXPLANATION);

    const multiTimedOutMidSelection: DepsOverrides = {
      questionType: QuestionType.MultipleAnswer,
      selectedOptionTexts: [RIGHT_TEXT],
      verdictPhase: 'expired',
      correctOptionTexts: [RIGHT_TEXT, OTHER_CORRECT_TEXT],
      explanation: AUTHORIZED_EXPLANATION,
      isTimedOut: true
    };
    expect(showsFetFor(multiTimedOutMidSelection)).toBe(true);
  });

  it('7a. an earned single-answer FET survives a refresh (verdict restored, no live signals)', () => {
    const over: DepsOverrides = {
      questionType: QuestionType.SingleAnswer,
      verdictPhase: 'resolved',
      isResolvedCorrect: true,
      correctOptionTexts: [RIGHT_TEXT],
      explanation: AUTHORIZED_EXPLANATION,
      // Reload: nothing live survives.
      hasInteracted: false,
      interactedThisVisit: false,
      isTimedOut: false,
      isNavigatingToPrevious: false
    };
    expect(showsFetFor(over)).toBe(true);
    expect(headingFor(over)).toBe(AUTHORIZED_EXPLANATION);
  });

  it('7b. an earned genuine-timeout FET survives a refresh', () => {
    const over: DepsOverrides = {
      questionType: QuestionType.SingleAnswer,
      verdictPhase: 'expired',
      correctOptionTexts: [RIGHT_TEXT],
      explanation: AUTHORIZED_EXPLANATION,
      hasInteracted: false,
      interactedThisVisit: false,
      isTimedOut: false,   // live timer signal does NOT survive a reload
      isNavigatingToPrevious: false
    };
    expect(showsFetFor(over)).toBe(true);
    expect(headingFor(over)).toBe(AUTHORIZED_EXPLANATION);
  });

  it('7c. THE REGRESSION, at the refresh boundary: a resolved-but-WRONG verdict must NOT reveal the FET after a reload either', () => {
    const over: DepsOverrides = {
      questionType: QuestionType.SingleAnswer,
      verdictPhase: 'resolved',
      isResolvedCorrect: false,
      correctOptionTexts: [RIGHT_TEXT],
      explanation: AUTHORIZED_EXPLANATION,
      hasInteracted: false,
      interactedThisVisit: false,
      isTimedOut: false,
      isNavigatingToPrevious: false
    };
    expect(showsFetFor(over)).toBe(false);
    expect(headingFor(over)).toBe(QUESTION);
  });

  it('a same-session Previous-revisit after a wrong-then-correct answer still shows the question (existing revisit contract, unaffected)', () => {
    const over: DepsOverrides = {
      questionType: QuestionType.SingleAnswer,
      verdictPhase: 'resolved',
      isResolvedCorrect: true,
      correctOptionTexts: [RIGHT_TEXT],
      explanation: AUTHORIZED_EXPLANATION,
      hasInteracted: true,
      interactedThisVisit: false,
      isNavigatingToPrevious: true
    };
    expect(showsFetFor(over)).toBe(false);
    expect(headingFor(over)).toBe(QUESTION);
  });
});
