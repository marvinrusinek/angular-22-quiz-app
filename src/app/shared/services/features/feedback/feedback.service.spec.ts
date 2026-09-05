/**
 * Regression coverage for the multi-answer feedback rules fixed this session
 * (2026-06-20):
 *   - The win ("You're right! ...") fires ONLY when every correct option is
 *     selected AND no incorrect option is selected. Picking any wrong option —
 *     even alongside all the correct ones — must yield "Not this one, try again!".
 *   - A partial-but-correct pick reports how many correct answers remain.
 *   - The feedback resolves correctness through the DISPLAYED question
 *     (getDisplayedQuestion), so "Option N" labels follow the shuffled order.
 *
 * The service reads window.location for its URL-authoritative short-circuit;
 * jsdom's default path ("/") does not match QUESTION_ROUTE_REGEX, so most tests
 * exercise the main path. The shuffle test opts in via history.pushState.
 */
import { TestBed } from '@angular/core/testing';

import { QuestionType } from '../../../models/question-type.enum';
import { Option } from '../../../models/Option.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';

import { ExplanationTextService } from '../explanation/explanation-text.service';
import { FeedbackService } from './feedback.service';
import { QuizService } from '../../data/quiz.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { QuestionVerdictService } from '../verdict/question-verdict.service';

function opt(optionId: number, text: string, correct: boolean, selected = false): Option {
  return { optionId, text, correct, selected, value: optionId } as unknown as Option;
}

function multiQuestion(options: Option[]): QuizQuestion {
  return {
    questionText: 'Select the correct statements',
    options,
    type: QuestionType.MultipleAnswer,
    explanation: ''
  } as unknown as QuizQuestion;
}

describe('FeedbackService.buildFeedbackMessage — multi-answer win condition', () => {
  let service: FeedbackService;
  let quizService: any;

  beforeEach(() => {
    quizService = {
      currentQuestionIndex: 0,
      getCurrentQuestionIndex: () => 0,
      questions: [] as QuizQuestion[],
      getDisplayedQuestion: (_i: number) => undefined as QuizQuestion | undefined,
      getPristineCorrectTextsForQuestion: (_t: string) => new Set<string>()
    };

    TestBed.configureTestingModule({
      providers: [
        FeedbackService,
        { provide: QuizService, useValue: quizService },
        { provide: ExplanationTextService, useValue: { latestExplanationIndex: -1, getCorrectOptionIndices: () => [] } },
        { provide: SelectedOptionService, useValue: { getSelectedOptionsForQuestion: (_i: number) => [] } }
      ]
    });
    service = TestBed.inject(FeedbackService);
  });

  afterEach(() => {
    // Reset the URL in case a test opted into the /question/ short-circuit.
    window.history.pushState({}, '', '/');
  });

  // options: Alpha(correct), Bravo(incorrect), Charlie(correct), Delta(incorrect)
  function scenario(selectedFlags: boolean[], targetIdx: number): string {
    const options = [
      opt(1, 'Alpha', true),
      opt(2, 'Bravo', false),
      opt(3, 'Charlie', true),
      opt(4, 'Delta', false)
    ];
    for (const [i, o] of options.entries()) o.selected = selectedFlags[i];
    const selected = options.filter((_, i) => selectedFlags[i]);
    const question = multiQuestion(options);
    return service.buildFeedbackMessage(question, selected, false, false, 0, options, options[targetIdx]);
  }

  it('one of two correct → reports how many correct answers remain', () => {
    // Alpha selected only (target Alpha).
    const msg = scenario([true, false, false, false], 0);
    expect(msg).toBe("That's correct! Please select 1 more correct answer.");
  });

  it('all correct selected, none incorrect → declares the win with displayed option numbers', () => {
    // Alpha + Charlie selected (target Charlie).
    const msg = scenario([true, false, true, false], 2);
    expect(msg).toBe("You're right! The correct answers are Options 1 and 3.");
  });

  it('correct then incorrect → "Not this one, try again!" (no premature win)', () => {
    // Alpha (correct) + Bravo (incorrect); just clicked Bravo.
    const msg = scenario([true, true, false, false], 1);
    expect(msg).toBe('Not this one, try again!');
  });

  it('ALL correct PLUS an incorrect → still blocked: any wrong pick prevents the win', () => {
    // Alpha + Charlie (both correct) + Bravo (incorrect); just clicked Bravo.
    // Pre-fix this declared the win because the correct count was met.
    const msg = scenario([true, true, true, false], 1);
    expect(msg).toBe('Not this one, try again!');
  });

  it('shuffle-aware: option numbers follow the DISPLAYED order (getDisplayedQuestion)', () => {
    // Displayed order puts the correct options at positions 2 and 4.
    const displayed = [
      opt(2, 'Bravo', false),
      opt(1, 'Alpha', true),
      opt(4, 'Delta', false),
      opt(3, 'Charlie', true)
    ];
    // Prove it uses the displayed question, not the raw questions[] array.
    quizService.questions = [multiQuestion([
      opt(1, 'Alpha', true), opt(2, 'Bravo', false), opt(3, 'Charlie', true), opt(4, 'Delta', false)
    ])];
    quizService.getDisplayedQuestion = (i: number) => (i === 0 ? multiQuestion(displayed) : undefined);
    window.history.pushState({}, '', '/question/demo/1');

    const options = displayed.map((o) => ({ ...o }));
    options[1].selected = true; // Alpha (displayed pos 2)
    options[3].selected = true; // Charlie (displayed pos 4)
    const selected = [options[1], options[3]];

    const msg = service.buildFeedbackMessage(
      multiQuestion(options), selected, false, false, 0, options, options[3]
    );
    expect(msg).toBe("You're right! The correct answers are Options 2 and 4.");
  });
});

/**
 * S5a: PARTIAL-PROGRESS MESSAGING RECOMPUTES FROM THE AUTHORIZED VERDICT.
 *
 * With `quizInitialState` permanently empty, the full correct-option set is
 * unauthorized before completion (the server deliberately never reveals it
 * early) — so `computeCorrectIndices` returns an empty array for a genuinely
 * incomplete multi-answer question, same as it always has for API-sourced
 * content. What was missing: nothing used the ONE thing `/check` DOES
 * disclose pre-completion, `remainingCorrectCount` — a count, not the answer
 * key — so a correct partial pick never told the player how many were left,
 * and `FeedbackComponent`'s own verdict-reactive effect had nothing to
 * recompute into.
 *
 * These tests would FAIL against the pre-fix implementation: with no pristine
 * `.correct` flags on the options (matching real `/questions` content) and
 * `correctIndices` therefore empty, `buildFeedbackMessage` returned `''`
 * unconditionally rather than consulting the verdict.
 */
describe('FeedbackService.buildFeedbackMessage — partial-progress from authorized remainingCorrectCount', () => {
  let service: FeedbackService;
  let quizService: any;
  let verdictService: { verdictFor: (quizId: string, questionText: string) => any };
  let currentVerdict: any;

  function apiOpt(text: string): Option {
    // No `correct` flag at all — matches the /questions API shape.
    return { text, selected: false } as unknown as Option;
  }

  function apiMultiQuestion(): QuizQuestion {
    return {
      questionText: 'Which are true?',
      options: [apiOpt('Alpha'), apiOpt('Bravo'), apiOpt('Charlie')],
      type: QuestionType.MultipleAnswer,
      explanation: ''
    } as unknown as QuizQuestion;
  }

  beforeEach(() => {
    currentVerdict = null;
    verdictService = {
      verdictFor: (_quizId: string, _questionText: string) => currentVerdict
    };

    quizService = {
      quizId: 'demo',
      currentQuestionIndex: 0,
      getCurrentQuestionIndex: () => 0,
      questions: [apiMultiQuestion()],
      getDisplayedQuestion: (_i: number) => undefined as QuizQuestion | undefined,
      getPristineCorrectTextsForQuestion: (_t: string) => new Set<string>()
    };

    TestBed.configureTestingModule({
      providers: [
        FeedbackService,
        { provide: QuizService, useValue: quizService },
        { provide: QuestionVerdictService, useValue: verdictService },
        { provide: ExplanationTextService, useValue: { latestExplanationIndex: -1, getCorrectOptionIndices: () => [] } },
        { provide: SelectedOptionService, useValue: { getSelectedOptionsForQuestion: (_i: number) => [] } }
      ]
    });
    service = TestBed.inject(FeedbackService);
  });

  afterEach(() => window.history.pushState({}, '', '/'));

  it('stays blank before any verdict exists — unknown is not a message, not a guess', () => {
    currentVerdict = null;
    const q = apiMultiQuestion();
    const alpha = q.options![0];
    alpha.selected = true;
    const msg = service.buildFeedbackMessage(q, [alpha], false, false, 0, q.options);
    expect(msg).toBe('');
  });

  it('recomputes to "Select 1 more" once the authorized incomplete verdict arrives', () => {
    const q = apiMultiQuestion();
    const alpha = q.options![0];
    alpha.selected = true;

    currentVerdict = {
      phase: 'incomplete',
      selectedOptionTexts: ['Alpha'],
      selectedVerdicts: new Map([['Alpha', true]]),
      remainingCorrectCount: 1,
      correctOptionTexts: [],
      explanation: null,
      isResolvedCorrect: null
    };

    const msg = service.buildFeedbackMessage(q, [alpha], false, false, 0, q.options);
    expect(msg).toBe("That's correct! Please select 1 more correct answer.");
  });

  it('reports the plural count correctly for more than one remaining', () => {
    const q = apiMultiQuestion();
    const alpha = q.options![0];
    alpha.selected = true;

    currentVerdict = {
      phase: 'incomplete',
      selectedOptionTexts: ['Alpha'],
      selectedVerdicts: new Map([['Alpha', true]]),
      remainingCorrectCount: 2,
      correctOptionTexts: [],
      explanation: null,
      isResolvedCorrect: null
    };

    const msg = service.buildFeedbackMessage(q, [alpha], false, false, 0, q.options);
    expect(msg).toBe("That's correct! Please select 2 more correct answers.");
  });

  it('claims "Not this one" when the CURRENTLY CLICKED option is the wrong one', () => {
    const q = apiMultiQuestion();
    const alpha = q.options![0];
    const bravo = q.options![1];
    alpha.selected = true;
    bravo.selected = true;

    currentVerdict = {
      phase: 'incomplete',
      selectedOptionTexts: ['Alpha', 'Bravo'],
      selectedVerdicts: new Map([['Alpha', true], ['Bravo', false]]),
      remainingCorrectCount: 1,
      correctOptionTexts: [],
      explanation: null,
      isResolvedCorrect: null
    };

    // targetOption identifies which click this message is FOR — bravo, the
    // one that was actually just (wrongly) clicked.
    const msg = service.buildFeedbackMessage(q, [alpha, bravo], false, false, 0, q.options, bravo);
    expect(msg).toBe('Not this one, try again!');
  });

  it('does NOT latch an earlier wrong click onto a LATER correct click\'s message (the regression: correct -> wrong -> correct)', () => {
    // The exact sequence reported live: Option A (correct), Option B (wrong),
    // Option C (correct). Clicking C must describe C's own verdict, not
    // B's leftover `false` still sitting in selectedVerdicts.
    const q = apiMultiQuestion();
    const alpha = q.options![0];
    const bravo = q.options![1];
    const charlie = q.options![2];
    alpha.selected = true;
    bravo.selected = true;
    charlie.selected = true;

    currentVerdict = {
      phase: 'incomplete',
      selectedOptionTexts: ['Alpha', 'Bravo', 'Charlie'],
      selectedVerdicts: new Map([['Alpha', true], ['Bravo', false], ['Charlie', true]]),
      remainingCorrectCount: 1,
      correctOptionTexts: [],
      explanation: null,
      isResolvedCorrect: null
    };

    const msg = service.buildFeedbackMessage(q, [alpha, bravo, charlie], false, false, 0, q.options, charlie);
    expect(msg).toBe("That's correct! Please select 1 more correct answer.");
    expect(msg).not.toBe('Not this one, try again!');
  });

  it('does not fabricate a count for a single-answer question (multi-only path)', () => {
    const q = {
      questionText: 'Pick one',
      options: [apiOpt('Right'), apiOpt('Wrong')],
      type: QuestionType.SingleAnswer,
      explanation: ''
    } as unknown as QuizQuestion;
    const right = q.options![0];
    right.selected = true;

    currentVerdict = {
      phase: 'incomplete',
      selectedOptionTexts: ['Right'],
      selectedVerdicts: new Map([['Right', true]]),
      remainingCorrectCount: 1,
      correctOptionTexts: [],
      explanation: null,
      isResolvedCorrect: null
    };

    const msg = service.buildFeedbackMessage(q, [right], false, false, 0, q.options);
    expect(msg).toBe('');
  });
});

describe('FeedbackService.buildFeedbackMessage — single-answer', () => {
  let service: FeedbackService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        FeedbackService,
        { provide: QuizService, useValue: { currentQuestionIndex: 0, getCurrentQuestionIndex: () => 0, questions: [], getDisplayedQuestion: () => undefined, getPristineCorrectTextsForQuestion: () => new Set<string>() } },
        { provide: ExplanationTextService, useValue: { latestExplanationIndex: -1, getCorrectOptionIndices: () => [] } },
        { provide: SelectedOptionService, useValue: { getSelectedOptionsForQuestion: () => [] } }
      ]
    });
    service = TestBed.inject(FeedbackService);
  });

  afterEach(() => window.history.pushState({}, '', '/'));

  function singleQuestion(): QuizQuestion {
    return {
      questionText: 'Pick the one correct answer',
      options: [opt(1, 'Right', true), opt(2, 'Wrong', false)],
      type: QuestionType.SingleAnswer,
      explanation: ''
    } as unknown as QuizQuestion;
  }

  it('correct pick → win', () => {
    const q = singleQuestion();
    const right = q.options![0];
    right.selected = true;
    const msg = service.buildFeedbackMessage(q, [right], false, false, 0, q.options, right);
    expect(msg).toBe("You're right! The correct answer is Option 1.");
  });

  it('incorrect pick → "Not this one, try again!"', () => {
    const q = singleQuestion();
    const wrong = q.options![1];
    wrong.selected = true;
    const msg = service.buildFeedbackMessage(q, [wrong], false, false, 0, q.options, wrong);
    expect(msg).toBe('Not this one, try again!');
  });
});
