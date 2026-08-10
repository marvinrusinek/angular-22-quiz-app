import { TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { QuestionType } from '../../../models/question-type.enum';

import { QuizDotStatusService } from '../../../services/flow/quiz-dot-status.service';
import { QuizService } from '../../../services/data/quiz.service';
import { SelectedOptionService } from '../../../services/state/selectedoption.service';
import { SelectionMessageService } from './selection-message.service';

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
  let selectedOptionServiceMock: any;

  const START_MSG = 'Please start the quiz by selecting an option.';
  const CONTINUE_MSG = 'Please select an option to continue...';
  const NEXT_BTN_MSG = 'Please click the Next button to continue.';
  const SHOW_RESULTS_MSG = 'Please click the Show Results button.';

  beforeEach(() => {
    quizServiceMock = {
      currentQuestionIndex: 0,
      currentQuestionIndexSig: () => 0,
      totalQuestions: () => 6,
      questions: [],
      shuffledQuestions: [],
      quizInitialState: [],
      isShuffleEnabled: jest.fn().mockReturnValue(false),
      currentQuestion: { value: null },
      scoringService: { questionCorrectness: new Map() },
      _multiAnswerPerfect: new Map(),
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
});
