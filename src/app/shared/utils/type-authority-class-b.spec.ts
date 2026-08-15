import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { QuestionType } from '../models/question-type.enum';
import type { QuizQuestion } from '../models/QuizQuestion.model';
import type { SelectedOption } from '../models/SelectedOption.model';

import { QuizDotStatusService } from '../services/flow/quiz-dot-status.service';
import { QuizPersistenceService } from '../services/state/quiz-persistence.service';
import { QuizService } from '../services/data/quiz.service';
import { QuizShuffleService } from '../services/flow/quiz-shuffle.service';
import { QuizStateService } from '../services/state/quizstate.service';
import { SelectedOptionService } from '../services/state/selectedoption.service';
import { SelectionMessageService } from '../services/features/selection-message/selection-message.service';
import { OptionClickHandlerService } from '../services/options/engine/option-click-handler.service';
import { API_BASE_URL } from '../tokens/api-base-url.token';

/**
 * CLASS B — THE COUNT MUST NOT PROMOTE.
 *
 * Every site covered here previously read some spelling of
 *
 *     question.type === MultipleAnswer || correctCount > 1
 *
 * where the count is an EQUAL ARM of the OR rather than a fallback. That makes
 * question type a derivative of the local answer key in the one direction that
 * matters: a declared SINGLE-answer (or trueFalse) question is silently
 * PROMOTED to multiple the moment the bank carries a second `correct` flag —
 * through drift, through a stale render, or through tampering.
 *
 * Only a fixture where the declared type and the count DISAGREE can detect
 * that. Every question below is built to disagree; one where they agree would
 * pass against the old code just as well as the new.
 */

// jsdom has no structuredClone; QuizService clones the bank at construction.
if (typeof (globalThis as any).structuredClone !== 'function') {
  (globalThis as any).structuredClone = (v: unknown) => JSON.parse(JSON.stringify(v));
}

/** A question whose `correct` flags deliberately contradict its declared type. */
const q = (
  type: QuestionType | undefined,
  correctCount: number,
  questionText = 'Which of these?'
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
// option-click-handler — determineQuestionType (radio vs checkbox)
// ══════════════════════════════════════════════════════════════════════

describe('determineQuestionType: interaction mode follows the DECLARED type', () => {
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

  it('stays single when declared single but the bank flags 3 correct', () => {
    // THE REGRESSION THIS PINS — the old OR returned 'multiple' from the count.
    expect(handler.determineQuestionType(q(QuestionType.SingleAnswer, 3))).toBe('single');
  });

  it('stays multiple when declared multiple but the bank flags only 1 correct', () => {
    expect(handler.determineQuestionType(q(QuestionType.MultipleAnswer, 1))).toBe('multiple');
  });

  it('stays multiple when declared multiple and the bank flags NONE correct', () => {
    // The shape the API returns once the answer key stops shipping entirely.
    expect(handler.determineQuestionType(q(QuestionType.MultipleAnswer, 0))).toBe('multiple');
  });

  it('gives a declared trueFalse question single-SELECTION interaction', () => {
    // The DECLARED type stays trueFalse on the question; this method returns an
    // interaction mode, and true/false is answered with one pick.
    expect(handler.determineQuestionType(q(QuestionType.TrueFalse, 2))).toBe('single');
  });

  it('falls back to the count when the type is UNDECLARED', () => {
    // REMOVE WITH THE /questions CONTENT CUTOVER. Undeclared is not "single":
    // treating a miss as single would turn multi-answer questions single while
    // the type request is still in flight.
    expect(handler.determineQuestionType(q(undefined, 3))).toBe('multiple');
    expect(handler.determineQuestionType(q(undefined, 1))).toBe('single');
  });

  it('still honours the legacy multipleAnswer flag when UNDECLARED', () => {
    const legacy = { ...q(undefined, 1), multipleAnswer: true } as any;
    expect(handler.determineQuestionType(legacy)).toBe('multiple');
  });

  it('a declared single BEATS the legacy multipleAnswer flag', () => {
    const legacy = { ...q(QuestionType.SingleAnswer, 1), multipleAnswer: true } as any;
    expect(handler.determineQuestionType(legacy)).toBe('single');
  });
});

// ══════════════════════════════════════════════════════════════════════
// quiz-dot-status — evaluateSelectionCorrectness / optimistic-correct gate
// ══════════════════════════════════════════════════════════════════════

describe('quiz-dot-status: the completeness rule follows the DECLARED type', () => {
  let service: QuizDotStatusService;
  let quizService: any;

  const sel = (o: Partial<SelectedOption>): SelectedOption => o as SelectedOption;

  const evaluate = (question: QuizQuestion, selections: SelectedOption[]) =>
    service.evaluateSelectionCorrectness({
      index: 0,
      selections,
      currentQuestionIndex: 0,
      optionsToDisplay: question.options as any,
      currentQuestion: question,
      questionsArray: [question]
    });

  beforeEach(() => {
    quizService = {
      quizId: 'quiz-1',
      isShuffleEnabled: jest.fn(() => false),
      questions: [],
      shuffledQuestions: [],
      activeQuiz: { questions: [] },
      selectedOptionsMap: new Map(),
      questionCorrectness: new Map(),
      userAnswers: [],
      getDisplayedQuestion: (i: number) => quizService.questions?.[i]
    };

    TestBed.configureTestingModule({
      providers: [
        QuizDotStatusService,
        { provide: QuizService, useValue: quizService },
        { provide: QuizShuffleService, useValue: { toOriginalIndex: jest.fn() } },
        {
          provide: QuizPersistenceService,
          useValue: { getPersistedDotStatus: jest.fn(() => null), setPersistedDotStatus: jest.fn() }
        },
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

  it('credits ONE correct pick on a declared single whose bank flags 3 correct', () => {
    // Promoted to multiple, this returned false: the multi branch demands EVERY
    // correct option, so a correct single-answer pick scored as wrong.
    const question = q(QuestionType.SingleAnswer, 3);
    quizService.questions = [question];

    expect(evaluate(question, [sel({ optionId: 1, text: 'opt1', correct: true })])).toBe(true);
  });

  it('still demands ALL correct picks on a declared multiple flagged 1 correct', () => {
    const question = q(QuestionType.MultipleAnswer, 2);
    quizService.questions = [question];

    // Only one of the two correct options selected — incomplete, not correct.
    expect(evaluate(question, [sel({ optionId: 1, text: 'opt1', correct: true })])).toBe(false);
    expect(
      evaluate(question, [
        sel({ optionId: 1, text: 'opt1', correct: true }),
        sel({ optionId: 2, text: 'opt2', correct: true })
      ])
    ).toBe(true);
  });

  it('treats a declared trueFalse as single-selection despite a misleading count', () => {
    const question = q(QuestionType.TrueFalse, 2);
    quizService.questions = [question];

    expect(evaluate(question, [sel({ optionId: 1, text: 'opt1', correct: true })])).toBe(true);
  });

  it('falls back to the count when the type is UNDECLARED', () => {
    const question = q(undefined, 2);
    quizService.questions = [question];

    // Counted as multiple: one of two correct options is not complete.
    expect(evaluate(question, [sel({ optionId: 1, text: 'opt1', correct: true })])).toBe(false);
  });

  it('reads the type of the DISPLAYED question under shuffle', () => {
    // Canonical position 0 is MULTIPLE; the question actually shown at display
    // index 0 is a declared SINGLE. Indexing the canonical array with a display
    // index is the identity defect fixed in 95a3d3cc, so the displayed question
    // is what must decide.
    const canonicalFirst = q(QuestionType.MultipleAnswer, 3, 'canonical first');
    const displayedFirst = q(QuestionType.SingleAnswer, 3, 'displayed first');

    quizService.questions = [canonicalFirst, displayedFirst];
    quizService.shuffledQuestions = [displayedFirst, canonicalFirst];
    quizService.isShuffleEnabled = jest.fn(() => true);
    quizService.getDisplayedQuestion = (i: number) => quizService.shuffledQuestions[i];

    // One correct pick on the DISPLAYED single-answer question is correct.
    // Resolved as multiple (the canonical slot's type) this would be false.
    expect(
      service.evaluateSelectionCorrectness({
        index: 0,
        selections: [sel({ optionId: 1, text: 'opt1', correct: true })],
        currentQuestionIndex: 0,
        optionsToDisplay: displayedFirst.options as any,
        currentQuestion: displayedFirst,
        questionsArray: [displayedFirst]
      })
    ).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════
// selection-message — resolveQType across all four call sites
// ══════════════════════════════════════════════════════════════════════

describe('selection-message: the message type follows the DECLARED type', () => {
  let service: SelectionMessageService;

  /** The one private resolver all four migrated call sites now share. */
  const resolve = (declared: QuestionType | undefined, correctCount: number): QuestionType =>
    (service as any).resolveQType(declared, correctCount);

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        SelectionMessageService,
        {
          provide: QuizService,
          useValue: {
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
            getCurrentQuestionIndex: () => 0
          }
        },
        { provide: SelectedOptionService, useValue: { selectedOptionsMap: new Map() } },
        { provide: QuizDotStatusService, useValue: { timedOutFetForced: new Set<number>() } },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } }
      ]
    });
    service = TestBed.inject(SelectionMessageService);
  });

  it('keeps a declared single single when the bank flags 3 correct', () => {
    // Promoted, the message kept telling the user to select more options on a
    // question that only ever had one answer.
    expect(resolve(QuestionType.SingleAnswer, 3)).toBe(QuestionType.SingleAnswer);
  });

  it('keeps a declared multiple multiple when the bank flags 1 correct', () => {
    expect(resolve(QuestionType.MultipleAnswer, 1)).toBe(QuestionType.MultipleAnswer);
  });

  it('PRESERVES trueFalse rather than collapsing it to SingleAnswer', () => {
    // The old expression could only ever emit MultipleAnswer or the declared
    // value; a trueFalse with two flagged options became MultipleAnswer.
    expect(resolve(QuestionType.TrueFalse, 2)).toBe(QuestionType.TrueFalse);
    expect(resolve(QuestionType.TrueFalse, 0)).toBe(QuestionType.TrueFalse);
  });

  it('falls back to the count when the type is UNDECLARED', () => {
    expect(resolve(undefined, 3)).toBe(QuestionType.MultipleAnswer);
    expect(resolve(undefined, 1)).toBe(QuestionType.SingleAnswer);
    expect(resolve(undefined, 0)).toBe(QuestionType.SingleAnswer);
  });

  it('emitFromClick resolves declared single as single despite 3 correct flags', () => {
    const pushed: string[] = [];
    (service as any).pushMessage = (msg: string) => pushed.push(msg);

    service.emitFromClick({
      index: 0,
      totalQuestions: 6,
      questionType: QuestionType.SingleAnswer,
      canonicalOptions: q(QuestionType.SingleAnswer, 3).options,
      onMessageChange: null
    });

    // The multi-answer message asks for more selections; a resolved single
    // never does.
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).not.toMatch(/select all|more|remaining/i);
  });
});
