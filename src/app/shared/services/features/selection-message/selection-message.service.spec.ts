import { TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { of, Subject } from 'rxjs';

import { QuestionType } from '../../../models/question-type.enum';

import { QuizDotStatusService } from '../../../services/flow/quiz-dot-status.service';
import { QuizService } from '../../../services/data/quiz.service';
import { SelectedOptionService } from '../../../services/state/selectedoption.service';
import { SelectionMessageService } from './selection-message.service';
import { QuestionVerdictService } from '../verdict/question-verdict.service';
import { IDLE_VERDICT_STATE } from '../verdict/question-verdict.types';
import type { QuestionVerdictState } from '../verdict/question-verdict.types';

/**
 * DESIGN NOTE — initial state is CONTINUE_MSG, not START_MSG
 *
 * Before the strict-computed refactor (P5), selectionMessageSig was a
 * WritableSignal initialized to START_MSG. Tests asserted that. After the
 * refactor it became a pure computed<string> derived from:
 *   currentQuestionIndexSig() + _clickOverride() + _completedIdxSet
 *
 * For Q1 unanswered (idx=0, no completed flag, no click override yet) the
 * computed returns CONTINUE_MSG via deriveNavMessageForIdx. START_MSG is
 * only produced when idx < 0 (pre-init), which the mocks don't simulate.
 *
 * If you're updating an existing test that expects START_MSG and finding
 * CONTINUE_MSG instead, this is why — it's not a regression, it's the
 * post-P5 derivation rule.
 */
describe('SelectionMessageService', () => {
  let service: SelectionMessageService;
  let quizServiceMock: any;
  let verdictState: QuestionVerdictState;
  let selectedOptionServiceMock: any;

  const START_MSG = 'Please start the quiz by selecting an option.';
  const CONTINUE_MSG = 'Please select an option to continue...';
  const NEXT_BTN_MSG = 'Please click the Next button to continue.';
  const SHOW_RESULTS_MSG = 'Please click the Show Results button.';

  beforeEach(() => {
    verdictState = IDLE_VERDICT_STATE;

    quizServiceMock = {
      quizId: 'typescript',
      getQuestionsInDisplayOrder: () => [
        { questionText: 'Q1' }, { questionText: 'Q2' }, { questionText: 'Q3' },
        { questionText: 'Q4' }, { questionText: 'Q5' }, { questionText: 'Q6' }
      ],
      currentQuestionIndex: 0,
      currentQuestionIndexSig: () => 0,
      totalQuestions: () => 6,
      questions: [],
      shuffledQuestions: [],
      quizInitialState: [],
      isShuffleEnabled: jest.fn().mockReturnValue(false),
      currentQuestion: { value: null },
      scoringService: { questionCorrectness: new Map() },
      questionResolved: new Map(),
      getCurrentQuestionIndex: () => 0,
    };

    selectedOptionServiceMock = {
      selectedOptionsMap: new Map(),
    };

    TestBed.configureTestingModule({
      providers: [
        SelectionMessageService,
        { provide: QuizService, useValue: quizServiceMock },
        {
          provide: QuestionVerdictService,
          useValue: {
            verdictFor: () => verdictState,
            terminalVerdicts$: new Subject()
          }
        },
        { provide: SelectedOptionService, useValue: selectedOptionServiceMock },
        { provide: QuizDotStatusService, useValue: { timedOutFetForced: new Set<number>() } },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } },
      ],
    });

    service = TestBed.inject(SelectionMessageService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('should initialize with CONTINUE_MSG (Q1 unanswered default)', () => {
    // Service was refactored to a strict computed signal that always derives
    // from currentQuestionIndexSig + _completedIdxSet. For idx=0 unanswered,
    // derive returns CONTINUE_MSG.
    expect(service.getCurrentMessage()).toBe(CONTINUE_MSG);
  });

  // ── resetAll ────────────────────────────────────────────────

  /**
   * The verdict the server returned for the question under test.
   *
   * These three cases used to pass by setting `option.correct` — the local
   * answer key. That is exactly the read the fix removed: an API-sourced
   * option carries no such flag, so classifying from it told a user who had
   * answered CORRECTLY to "select the correct answer". Correctness is stated
   * here instead, as the authority states it.
   */
  function resolvedWith(correctText: string, selectedText: string): void {
    verdictState = {
      ...IDLE_VERDICT_STATE,
      phase: 'resolved',
      selectedOptionTexts: [selectedText],
      selectedVerdicts: new Map([[selectedText, selectedText === correctText]]),
      correctOptionTexts: [correctText],
      remainingCorrectCount: 0,
      isResolvedCorrect: selectedText === correctText
    } as QuestionVerdictState;
  }

  describe('resetAll', () => {
    it('should reset back to derived default after resetAll', () => {
      service.pushMessage('some other message', 0);
      service.resetAll();
      // After reset, _completedIdxSet is cleared and override is gone, so the
      // computed re-derives CONTINUE_MSG for idx=0 unanswered.
      expect(service.getCurrentMessage()).toBe(CONTINUE_MSG);
    });

    it('should clear all locks', () => {
      service._singleAnswerCorrectLock.add(0);
      service._singleAnswerIncorrectLock.add(1);
      service.resetAll();
      expect(service._singleAnswerCorrectLock.size).toBe(0);
      expect(service._singleAnswerIncorrectLock.size).toBe(0);
    });

    it('should clear last message map', () => {
      service._lastMessageByIndex.set(0, 'old msg');
      service.resetAll();
      expect(service._lastMessageByIndex.size).toBe(0);
    });

    it('should clear options snapshot', () => {
      service.setOptionsSnapshot([{ text: 'A', value: 1 }]);
      service.resetAll();
      expect(service.optionsSnapshot).toEqual([]);
    });
  });

  // ── computeFinalMessage ───────────────────────────────────��─

  describe('computeFinalMessage', () => {
    it('should return START_MSG for index 0 with no selections', () => {
      const msg = service.computeFinalMessage({
        index: 0,
        total: 6,
        qType: QuestionType.SingleAnswer,
        opts: [
          { text: 'A', correct: true, selected: false, value: 1 },
          { text: 'B', correct: false, selected: false, value: 2 },
        ],
      });
      expect(msg).toBe(START_MSG);
    });

    it('should return CONTINUE_MSG for non-zero index with no selections', () => {
      const msg = service.computeFinalMessage({
        index: 2,
        total: 6,
        qType: QuestionType.SingleAnswer,
        opts: [
          { text: 'A', correct: true, selected: false, value: 1 },
          { text: 'B', correct: false, selected: false, value: 2 },
        ],
      });
      expect(msg).toBe(CONTINUE_MSG);
    });

    it('should return NEXT_BTN_MSG when correct single answer is selected', () => {
      resolvedWith('A', 'A');
      const msg = service.computeFinalMessage({
        index: 0,
        total: 6,
        qType: QuestionType.SingleAnswer,
        opts: [
          { text: 'A', correct: true, selected: true, value: 1 },
          { text: 'B', correct: false, selected: false, value: 2 },
        ],
      });
      expect(msg).toBe(NEXT_BTN_MSG);
    });

    it('should return SHOW_RESULTS_MSG when correct answer selected on last question', () => {
      resolvedWith('A', 'A');
      const msg = service.computeFinalMessage({
        index: 5,
        total: 6,
        qType: QuestionType.SingleAnswer,
        opts: [
          { text: 'A', correct: true, selected: true, value: 1 },
          { text: 'B', correct: false, selected: false, value: 2 },
        ],
      });
      expect(msg).toBe(SHOW_RESULTS_MSG);
    });

    it('should return "select correct answer" when wrong answer selected', () => {
      resolvedWith('A', 'B');
      const msg = service.computeFinalMessage({
        index: 0,
        total: 6,
        qType: QuestionType.SingleAnswer,
        opts: [
          { text: 'A', correct: true, selected: false, value: 1 },
          { text: 'B', correct: false, selected: true, value: 2 },
        ],
      });
      expect(msg).toBe('Please select the correct answer to continue.');
    });

    it('should show remaining count for multi-answer with partial selection', () => {
      const msg = service.computeFinalMessage({
        index: 0,
        total: 6,
        qType: QuestionType.MultipleAnswer,
        opts: [
          { text: 'A', correct: true, selected: true, value: 1 },
          { text: 'B', correct: true, selected: false, value: 2 },
          { text: 'C', correct: false, selected: false, value: 3 },
        ],
      });
      expect(msg).toBe('Select 1 more correct answer to continue...');
    });

    it('gives a COUNT-FREE multi-answer prompt before anything is selected', () => {
      // The options below carry two `correct: true` flags. The prompt must not
      // reflect that: how many correct answers exist is answer-key knowledge,
      // and the user has not yet earned it. It used to read
      // "Select 2 correct options to continue...".
      const msg = service.computeFinalMessage({
        index: 0,
        total: 6,
        qType: QuestionType.MultipleAnswer,
        opts: [
          { text: 'A', correct: true, selected: false, value: 1 },
          { text: 'B', correct: true, selected: false, value: 2 },
          { text: 'C', correct: false, selected: false, value: 3 },
        ],
      });
      expect(msg).toBe('Select all that apply');
      expect(msg).not.toMatch(/\d/);
    });

    it('the prompt does not change when the number of correct options does', () => {
      // The decisive check: a question with THREE correct options produces the
      // identical prompt. If the count leaked, these would differ.
      const promptFor = (correctCount: number) =>
        service.computeFinalMessage({
          index: 0,
          total: 6,
          qType: QuestionType.MultipleAnswer,
          opts: [
            { text: 'A', correct: correctCount >= 1, selected: false, value: 1 },
            { text: 'B', correct: correctCount >= 2, selected: false, value: 2 },
            { text: 'C', correct: correctCount >= 3, selected: false, value: 3 },
          ],
        });

      expect(promptFor(1)).toBe(promptFor(3));
      expect(promptFor(1)).toBe('Select all that apply');
    });

    it('should return NEXT_BTN_MSG when all correct multi-answers selected', () => {
      const msg = service.computeFinalMessage({
        index: 0,
        total: 6,
        qType: QuestionType.MultipleAnswer,
        opts: [
          { text: 'A', correct: true, selected: true, value: 1 },
          { text: 'B', correct: true, selected: true, value: 2 },
          { text: 'C', correct: false, selected: false, value: 3 },
        ],
      });
      expect(msg).toBe(NEXT_BTN_MSG);
    });

    it('should return START_MSG for empty opts at index 0', () => {
      const msg = service.computeFinalMessage({
        index: 0,
        total: 6,
        qType: QuestionType.SingleAnswer,
        opts: [],
      });
      expect(msg).toBe(START_MSG);
    });
  });

  // ── pushMessage ─────────────────────────────────────────────

  describe('pushMessage', () => {
    it('should update the signal value', () => {
      service.pushMessage('New message', 0);
      expect(service.getCurrentMessage()).toBe('New message');
    });

    it('should not push if message is the same', () => {
      service.pushMessage(START_MSG, 0);
      expect(service.getCurrentMessage()).toBe(START_MSG);
    });
  });

  // ── forceNextButtonMessage ──────────────────────────────────

  describe('forceNextButtonMessage', () => {
    it('should set NEXT_BTN_MSG for non-last question', () => {
      quizServiceMock.totalQuestions = () => 6;
      service.forceNextButtonMessage(0);
      expect(service.getCurrentMessage()).toBe(NEXT_BTN_MSG);
    });

    it('should set SHOW_RESULTS_MSG for last question', () => {
      quizServiceMock.totalQuestions = () => 6;
      // Move the current index to 5 so the strict-computed signal honors the
      // click override pushed for that index.
      quizServiceMock.currentQuestionIndexSig = () => 5;
      service.forceNextButtonMessage(5);
      expect(service.getCurrentMessage()).toBe(SHOW_RESULTS_MSG);
    });

    it('should release baseline for the index', () => {
      service.forceNextButtonMessage(2);
      expect(service._baselineReleased.has(2)).toBe(true);
    });
  });
  /**
   * SINGLE-ANSWER MESSAGES COME FROM THE VERDICT.
   *
   * The regression: a CORRECT pick was told "Please select the correct answer to
   * continue." Tracing the live path showed both halves —
   *
   *     selected=[{"t":"constructor","corr":false,"own":false}]  phase=checking
   *     selectedCorrect=0  selectedWrong=1  -> BRANCH=wrong
   *
   * `own=false`: an API-sourced option carries no `correct` at all, so the old
   * `isOptionCorrect` scan classified every pick as wrong. `phase=checking`: at
   * click time nothing has judged it yet, so no source could have answered.
   *
   * The branch therefore has to WAIT, and the arrival has to recompute. These pin
   * both, plus the latch that made the wrong message survive navigation.
   */
  describe('single-answer selection message — authorized, and never latched early', () => {
    const CHECKING = 'Checking…';

    /** An API-sourced option: text and selection state, and NO correct flag. */
    function apiOpts(selectedText: string) {
      return [
        { text: 'A', selected: selectedText === 'A', value: 1 },
        { text: 'B', selected: selectedText === 'B', value: 2 }
      ] as any[];
    }

    it('CHECKING: a pick with no verdict says "Checking", not "wrong"', () => {
      verdictState = { ...IDLE_VERDICT_STATE, phase: 'checking' } as QuestionVerdictState;
      const msg = service.computeFinalMessage({
        index: 0, total: 6, qType: QuestionType.SingleAnswer, opts: apiOpts('A')
      });
      expect(msg).toBe(CHECKING);
      expect(msg).not.toContain('select the correct answer');
    });

    it('CHECKING writes NEITHER lock — this is what made the bad message stick', () => {
      verdictState = { ...IDLE_VERDICT_STATE, phase: 'checking' } as QuestionVerdictState;
      service.computeFinalMessage({
        index: 2, total: 6, qType: QuestionType.SingleAnswer, opts: apiOpts('A')
      });
      expect((service as any)._singleAnswerIncorrectLock.has(2)).toBe(false);
      expect((service as any)._singleAnswerCorrectLock.has(2)).toBe(false);
    });

    it('RESOLVED + correct: Next button, from options carrying NO correct flag', () => {
      resolvedWith('A', 'A');
      const opts = apiOpts('A');
      for (const o of opts) {
        expect(Object.prototype.hasOwnProperty.call(o, 'correct')).toBe(false);
      }
      const msg = service.computeFinalMessage({
        index: 0, total: 6, qType: QuestionType.SingleAnswer, opts
      });
      expect(msg).toBe(NEXT_BTN_MSG);
    });

    it('RESOLVED + wrong: the select-correct prompt', () => {
      resolvedWith('A', 'B');
      const msg = service.computeFinalMessage({
        index: 0, total: 6, qType: QuestionType.SingleAnswer, opts: apiOpts('B')
      });
      expect(msg).toBe('Please select the correct answer to continue.');
    });

    it('a correct answer CLEARS any earlier incorrect lock', () => {
      (service as any)._singleAnswerIncorrectLock.add(3);
      resolvedWith('A', 'A');
      const msg = service.computeFinalMessage({
        index: 3, total: 6, qType: QuestionType.SingleAnswer, opts: apiOpts('A')
      });
      expect(msg).toBe(NEXT_BTN_MSG);
      expect((service as any)._singleAnswerIncorrectLock.has(3)).toBe(false);
      expect((service as any)._singleAnswerCorrectLock.has(3)).toBe(true);
    });

    it('REVISIT: recomputing a resolved-correct question still says Next', () => {
      resolvedWith('A', 'A');
      const args = {
        index: 1, total: 6, qType: QuestionType.SingleAnswer, opts: apiOpts('A')
      };
      expect(service.computeFinalMessage(args)).toBe(NEXT_BTN_MSG);
      // Navigating away and back recomputes from the same authorized verdict.
      expect(service.computeFinalMessage(args)).toBe(NEXT_BTN_MSG);
    });

    it('no selection at all still yields the ordinary prompt', () => {
      verdictState = IDLE_VERDICT_STATE;
      const msg = service.computeFinalMessage({
        index: 2, total: 6, qType: QuestionType.SingleAnswer,
        opts: [{ text: 'A', selected: false, value: 1 }] as any[]
      });
      expect(msg).toBe(CONTINUE_MSG);
    });
  });
});