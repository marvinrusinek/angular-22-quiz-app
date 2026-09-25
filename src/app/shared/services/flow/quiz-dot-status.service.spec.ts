import { TestBed } from '@angular/core/testing';

import { QuestionType } from '@shared/models/question-type.enum';

import { Option } from '@shared/models/Option.model';
import { QuizQuestion } from '@shared/models/QuizQuestion.model';
import { SelectedOption } from '@shared/models/SelectedOption.model';

import { QuizPersistenceService } from '@shared/services/state/quiz-persistence.service';
import { QuizService } from '@shared/services/data/quiz.service';
import { QuizShuffleService } from './quiz-shuffle.service';
import { QuizStateService } from '@shared/services/state/quizstate.service';
import { SelectedOptionService } from '@shared/services/state/selectedoption.service';

import { QuizDotStatusService } from './quiz-dot-status.service';

/**
 * Unit coverage for QuizDotStatusService (added 2026-06-27 per the CODE_REVIEW
 * roadmap — one of the top-LOC services that had ~0 unit tests). Scope is the
 * deterministic, dependency-light public surface: state-map helpers, scoring-key
 * resolution (shuffle on/off), question lookup, selection<->option matching,
 * correct-option resolution (answer-array vs correct-flag fallback), the
 * single/multi-answer correctness evaluation, and the optimistic-correct gate.
 * The full getQuestionStatus decision tree (12+ branches over 5 collaborators)
 * is intentionally left to the e2e net that exercises it end-to-end.
 */
describe('QuizDotStatusService', () => {
  let service: QuizDotStatusService;
  let quizService: any;
  let quizShuffleService: any;
  let persistence: any;

  // ── option / question fixtures ──────────────────────────────────
  const singleAnswer: QuizQuestion = {
    questionText: 'Single',
    explanation: 'e',
    type: QuestionType.SingleAnswer,
    options: [
      { optionId: 1, text: 'Right', correct: true, value: 1 },
      { optionId: 2, text: 'Wrong', correct: false, value: 2 }
    ]
  };

  const multiAnswer: QuizQuestion = {
    questionText: 'Multi',
    explanation: 'e',
    type: QuestionType.MultipleAnswer,
    options: [
      { optionId: 10, text: 'A', correct: true, value: 1 },
      { optionId: 11, text: 'B', correct: false, value: 2 },
      { optionId: 12, text: 'C', correct: true, value: 3 }
    ]
  };

  const sel = (o: Partial<SelectedOption>): SelectedOption => o as SelectedOption;

  beforeEach(() => {
    quizService = {
      quizId: 'quiz-1',
      isShuffleEnabled: jest.fn(() => false),
      questions: [],
      activeQuiz: { questions: [] },
      selectedOptionsMap: new Map(),
      questionCorrectness: new Map(),
      userAnswers: []
    };
    quizShuffleService = {
      toOriginalIndex: jest.fn()
    };
    persistence = {
      getPersistedDotStatus: jest.fn(() => null),
      setPersistedDotStatus: jest.fn()
    };

    TestBed.configureTestingModule({
      providers: [
        QuizDotStatusService,
        { provide: QuizService, useValue: quizService },
        { provide: QuizShuffleService, useValue: quizShuffleService },
        { provide: QuizPersistenceService, useValue: persistence },
        {
          provide: QuizStateService,
          useValue: {
            _answeredQuestionIndices: new Set(),
            _hasUserInteracted: new Set(),
            hasUserInteracted: jest.fn(() => false)
          }
        },
        {
          provide: SelectedOptionService,
          useValue: {
            selectedOptionsMap: new Map(),
            clickConfirmedDotStatus: new Map(),
            lastClickedCorrectByQuestion: new Map(),
            hasRefreshBackup: false
          }
        }
      ]
    });
    service = TestBed.inject(QuizDotStatusService);
  });

  // ── state-map helpers ───────────────────────────────────────────
  describe('state map helpers', () => {
    it('clearAllMaps empties every tracking map/set', () => {
      service.dotStatusCache.set(0, 'correct');
      service.pendingDotStatusOverrides.set(0, 'wrong');
      service.activeDotClickStatus.set(1, 'correct');
      service.timerExpiredUnanswered.add(2);
      service.timedOutFetForced.add(3);

      service.clearAllMaps();

      expect(service.dotStatusCache.size).toBe(0);
      expect(service.pendingDotStatusOverrides.size).toBe(0);
      expect(service.activeDotClickStatus.size).toBe(0);
      expect(service.timerExpiredUnanswered.size).toBe(0);
      expect(service.timedOutFetForced.size).toBe(0);
    });

    it('clearForIndex removes only the three dot maps for that index', () => {
      service.dotStatusCache.set(5, 'correct');
      service.pendingDotStatusOverrides.set(5, 'wrong');
      service.activeDotClickStatus.set(5, 'correct');
      service.timerExpiredUnanswered.add(5);

      service.clearForIndex(5);

      expect(service.dotStatusCache.has(5)).toBe(false);
      expect(service.pendingDotStatusOverrides.has(5)).toBe(false);
      expect(service.activeDotClickStatus.has(5)).toBe(false);
      // timerExpiredUnanswered is intentionally NOT cleared here
      expect(service.timerExpiredUnanswered.has(5)).toBe(true);
    });
  });

  // ── computeTotalCount ───────────────────────────────────────────
  describe('computeTotalCount', () => {
    it('prefers totalQuestions when positive', () => {
      expect(service.computeTotalCount(10, 5, 3)).toBe(10);
    });

    it('falls back to service length, then quiz length', () => {
      expect(service.computeTotalCount(0, 5, 3)).toBe(5);
      expect(service.computeTotalCount(0, 0, 3)).toBe(3);
    });
  });

  // ── scoring key ─────────────────────────────────────────────────
  describe('getScoringKey / getCandidateQuestionIndices', () => {
    it('returns the index unchanged when shuffle is off', () => {
      quizService.isShuffleEnabled.mockReturnValue(false);
      expect(service.getScoringKey('quiz-1', 4)).toBe(4);
      expect(quizShuffleService.toOriginalIndex).not.toHaveBeenCalled();
    });

    it('maps to the original index when shuffle is on', () => {
      quizService.isShuffleEnabled.mockReturnValue(true);
      quizShuffleService.toOriginalIndex.mockReturnValue(7);
      expect(service.getScoringKey('quiz-1', 2)).toBe(7);
      expect(quizShuffleService.toOriginalIndex).toHaveBeenCalledWith('quiz-1', 2);
    });

    it('falls back to the display index when the shuffle map has no entry', () => {
      quizService.isShuffleEnabled.mockReturnValue(true);
      quizShuffleService.toOriginalIndex.mockReturnValue(-1);
      expect(service.getScoringKey('quiz-1', 2)).toBe(2);
    });

    it('candidate indices dedupe display + scoring keys', () => {
      quizService.isShuffleEnabled.mockReturnValue(true);
      quizShuffleService.toOriginalIndex.mockReturnValue(7);
      expect(service.getCandidateQuestionIndices('quiz-1', 2)).toEqual([2, 7]);

      quizShuffleService.toOriginalIndex.mockReturnValue(2);
      expect(service.getCandidateQuestionIndices('quiz-1', 2)).toEqual([2]);
    });
  });

  // ── question lookup ─────────────────────────────────────────────
  describe('getQuestionForIndex', () => {
    it('falls back to the passed questionsArray when the service has none', () => {
      expect(service.getQuestionForIndex(0, [singleAnswer])).toBe(singleAnswer);
    });

    it('prefers the service questions array when populated', () => {
      quizService.questions = [multiAnswer];
      expect(service.getQuestionForIndex(0, [singleAnswer])).toBe(multiAnswer);
    });

    it('returns null when nothing resolves', () => {
      expect(service.getQuestionForIndex(9, [])).toBeNull();
    });
  });

  // ── selection <-> option matching ───────────────────────────────
  describe('selectionMatchesOption', () => {
    it('matches by optionId', () => {
      expect(service.selectionMatchesOption({ optionId: 3 }, { optionId: 3 })).toBe(true);
    });

    it('matches by normalized text (case/whitespace-insensitive)', () => {
      expect(service.selectionMatchesOption({ text: '  Hello ' }, { text: 'hello' })).toBe(true);
    });

    it('matches by display index when ids/text differ', () => {
      expect(service.selectionMatchesOption({ displayIndex: 2 } as any, { text: 'x' }, 2)).toBe(true);
    });

    it('returns false on mismatch and on null inputs', () => {
      expect(service.selectionMatchesOption({ optionId: 1 }, { optionId: 2 })).toBe(false);
      expect(service.selectionMatchesOption(null, { optionId: 2 })).toBe(false);
      expect(service.selectionMatchesOption({ optionId: 1 }, null)).toBe(false);
    });
  });

  // ── correct-option resolution ───────────────────────────────────
  describe('getResolvedCorrectOptionEntries', () => {
    it('resolves correct options from the correct flag', () => {
      const entries = service.getResolvedCorrectOptionEntries(multiAnswer);
      expect(entries.map(e => e.option.text)).toEqual(['A', 'C']);
      expect(entries.map(e => e.index)).toEqual([0, 2]);
    });

    it('resolves from the answer array when present', () => {
      const q: QuizQuestion = {
        ...singleAnswer,
        answer: [{ optionId: 2, text: 'Wrong', correct: true, value: 2 }] as any
      };
      const entries = service.getResolvedCorrectOptionEntries(q);
      expect(entries.map(e => e.option.optionId)).toEqual([2]);
    });

    it('uses fallback options when the question has none', () => {
      const entries = service.getResolvedCorrectOptionEntries(null, multiAnswer.options);
      expect(entries.map(e => e.option.text)).toEqual(['A', 'C']);
    });

    it('returns [] when there are no options at all', () => {
      expect(service.getResolvedCorrectOptionEntries(null, [])).toEqual([]);
    });
  });

  describe('matchesAnyCorrectOption', () => {
    it('is true for a selection of a correct option', () => {
      expect(service.matchesAnyCorrectOption({ optionId: 12 }, multiAnswer)).toBe(true);
    });

    it('is false for a selection of an incorrect option', () => {
      expect(service.matchesAnyCorrectOption({ optionId: 11 }, multiAnswer)).toBe(false);
    });
  });

  // ── correctness evaluation ──────────────────────────────────────
  describe('evaluateSelectionCorrectness', () => {
    const evalFor = (selections: SelectedOption[], question: QuizQuestion) =>
      service.evaluateSelectionCorrectness({
        index: 0,
        selections,
        currentQuestionIndex: 0,
        optionsToDisplay: question.options as Option[],
        currentQuestion: question,
        questionsArray: [question]
      });

    it('single-answer: correct pick -> true', () => {
      expect(evalFor([sel({ optionId: 1, selected: true })], singleAnswer)).toBe(true);
    });

    it('single-answer: wrong pick -> false', () => {
      expect(evalFor([sel({ optionId: 2, selected: true })], singleAnswer)).toBe(false);
    });

    it('multi-answer: all correct -> true', () => {
      expect(evalFor(
        [sel({ optionId: 10, selected: true }), sel({ optionId: 12, selected: true })],
        multiAnswer
      )).toBe(true);
    });

    it('multi-answer: partial (one of two) -> false', () => {
      expect(evalFor([sel({ optionId: 10, selected: true })], multiAnswer)).toBe(false);
    });

    it('multi-answer: any incorrect pick -> false', () => {
      expect(evalFor(
        [sel({ optionId: 10, selected: true }), sel({ optionId: 11, selected: true })],
        multiAnswer
      )).toBe(false);
    });

    it('returns null when there are no selections', () => {
      expect(evalFor([], multiAnswer)).toBeNull();
    });
  });

  // ── optimistic-correct gate ─────────────────────────────────────
  describe('hasOptimisticCorrectSelection', () => {
    const optimisticFor = (selections: SelectedOption[], question: QuizQuestion) =>
      service.hasOptimisticCorrectSelection({
        index: 0,
        selections,
        currentQuestionIndex: 0,
        optionsToDisplay: question.options as Option[],
        currentQuestion: question,
        questionsArray: [question]
      });

    it('is true when ALL of a multi-answer question is correctly selected', () => {
      expect(optimisticFor(
        [sel({ optionId: 10, selected: true }), sel({ optionId: 12, selected: true })],
        multiAnswer
      )).toBe(true);
    });

    it('is false for a single-correct question (needs >1 correct option)', () => {
      expect(optimisticFor([sel({ optionId: 1, selected: true })], singleAnswer)).toBe(false);
    });

    it('is false when an incorrect option is among the selections', () => {
      expect(optimisticFor(
        [sel({ optionId: 10, selected: true }), sel({ optionId: 11, selected: true })],
        multiAnswer
      )).toBe(false);
    });

    it('is false with no selections', () => {
      expect(optimisticFor([], multiAnswer)).toBe(false);
    });
  });
});
