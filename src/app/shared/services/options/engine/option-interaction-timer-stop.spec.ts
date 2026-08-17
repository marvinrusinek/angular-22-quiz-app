import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { OptionInteractionService } from './option-interaction.service';
import { QuestionVerdictService } from '../../features/verdict/question-verdict.service';
import { QuizService } from '../../data/quiz.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { TimerService } from '../../features/timer/timer.service';
import { setQuizDataCache } from '../../../quiz-data-cache';
import type { Quiz } from '../../../models/Quiz.model';
import type { QuizQuestion } from '../../../models/QuizQuestion.model';

/**
 * TIMER STOP derived from verdict state (Stage 9D).
 *
 * The timer must stop when the user has answered correctly, and that decision
 * now comes from `QuestionVerdictService` rather than from a direct read of
 * `option.correct`. Correctness is the private answer key, so the rule that
 * consumes it has to run on the authority that will survive the API cutover.
 *
 * Two different questions are involved and they are NOT the same:
 *   - single-answer: terminal on ANY click, but stops only on a CORRECT click
 *   - multi-answer:  stops only once EVERY correct option has been selected
 *
 * The pristine `.correct` fallback is retained only for the case where no
 * verdict exists yet (Stage 10 removes it along with the local bank).
 */

const SINGLE = 'Which operator maps values?';   // correct: map
const MULTI = 'Select every operator';          // correct: map, filter

const QUESTIONS = [
  {
    questionText: SINGLE,
    explanation: 'map transforms each emitted value.',
    options: [
      { text: 'map', correct: true },
      { text: 'Observable' },
      { text: 'Subject' }
    ]
  },
  {
    questionText: MULTI,
    explanation: 'map and filter are operators.',
    options: [
      { text: 'map', correct: true },
      { text: 'filter', correct: true },
      { text: 'Observable' }
    ]
  }
];

const BANK = [
  {
    quizId: 'rxjs',
    milestone: 'RxJS',
    questions: QUESTIONS
  }
] as unknown as Quiz[];

// jsdom has no structuredClone; QuizService uses it at construction.
if (typeof (globalThis as any).structuredClone !== 'function') {
  (globalThis as any).structuredClone = (value: unknown) => JSON.parse(JSON.stringify(value));
}

let service: OptionInteractionService;
let selectedOptionService: SelectedOptionService;
let verdicts: QuestionVerdictService;
let stopSpy: jest.SpyInstance;

const questionAt = (i: number): QuizQuestion =>
  JSON.parse(JSON.stringify(QUESTIONS[i]!)) as QuizQuestion;

const optionNamed = (question: QuizQuestion, text: string) =>
  question.options.find((o) => o.text === text)!;

/** The production truth-source for the retained compatibility fallback. */
const pristineCorrect = (o: any): boolean => o?.correct === true;

/** Never correct — used to prove the verdict is preferred over the fallback. */
const pristineSaysNo = (): boolean => false;

/**
 * Record a selection the way production does: through the single submission
 * owner, so the verdict is produced by the real adapter rather than stubbed.
 */
const selectOnQuestion = (index: number, texts: string[]) =>
  selectedOptionService.setUiSelectedTextsForQuestion(index, texts);

/** Mirrors how `handleOptionClick` derives `allCorrectFound` in phase 3. */
const allCorrectFound = (question: QuizQuestion): boolean =>
  (service as any).allCorrectFromVerdict(question) === true;

const runTimerStop = (opts: {
  question: QuizQuestion;
  clicked: any;
  isMultipleMode: boolean;
  allCorrectFound: boolean;
  isShuffleActive?: boolean;
  isPristineCorrect?: (o: any) => boolean;
}) =>
  (service as any).stopTimerIfAnswerCorrect(
    opts.isShuffleActive ?? false,
    opts.isMultipleMode,
    opts.isPristineCorrect ?? pristineCorrect,
    opts.clicked,
    opts.allCorrectFound,
    opts.question
  );

beforeEach(() => {
  setQuizDataCache(JSON.parse(JSON.stringify(BANK)) as Quiz[], []);

  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } }
    ]
  });

  const quizService = TestBed.inject(QuizService);
  (quizService as any).quizId = 'rxjs';
  // Stated explicitly through the setter. These specs used to set only the
  // SIGNAL and let QuizService's constructor seed the backing array from the
  // mocked bank. S4 removed that constructor-time seed (it was handing every
  // session the FIRST quiz in the bank regardless of route), so a spec that
  // needs questions now has to say so.
  quizService.questions = JSON.parse(JSON.stringify(QUESTIONS)) as never;

  service = TestBed.inject(OptionInteractionService);
  selectedOptionService = TestBed.inject(SelectedOptionService);
  verdicts = TestBed.inject(QuestionVerdictService);
  stopSpy = jest.spyOn(TestBed.inject(TimerService), 'stopTimer').mockImplementation(() => undefined as never);
});

afterEach(() => {
  stopSpy.mockRestore();
  setQuizDataCache([], []);
});

describe('single-answer', () => {
  it('a CORRECT click stops the timer', () => {
    const question = questionAt(0);
    selectOnQuestion(0, ['map']);

    runTimerStop({ question, clicked: optionNamed(question, 'map'), isMultipleMode: false, allCorrectFound: true });

    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it('an INCORRECT click does NOT stop the timer', () => {
    const question = questionAt(0);
    selectOnQuestion(0, ['Observable']);

    // Single-answer is terminal on any click, but the timer must keep running:
    // terminal and correct are different questions.
    runTimerStop({
      question,
      clicked: optionNamed(question, 'Observable'),
      isMultipleMode: false,
      allCorrectFound: allCorrectFound(question)
    });

    expect(stopSpy).not.toHaveBeenCalled();
  });
});

describe('multi-answer', () => {
  it('a PARTIAL selection does NOT stop the timer', () => {
    const question = questionAt(1);
    selectOnQuestion(1, ['map']);

    expect(verdicts.verdictFor('rxjs', MULTI).phase).toBe('incomplete');

    runTimerStop({
      question,
      clicked: optionNamed(question, 'map'),
      isMultipleMode: true,
      allCorrectFound: allCorrectFound(question)
    });

    expect(stopSpy).not.toHaveBeenCalled();
  });

  it('selecting ALL correct options stops the timer', () => {
    const question = questionAt(1);
    selectOnQuestion(1, ['map', 'filter']);

    expect(verdicts.verdictFor('rxjs', MULTI).phase).toBe('resolved');

    runTimerStop({
      question,
      clicked: optionNamed(question, 'filter'),
      isMultipleMode: true,
      allCorrectFound: allCorrectFound(question)
    });

    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it('SUPERSET: all correct PLUS an incorrect pick still stops the timer', () => {
    const question = questionAt(1);
    selectOnQuestion(1, ['map', 'filter', 'Observable']);

    // The shipped Topic Quiz rule is correctSet ⊆ selectedSet, not exact-set
    // equality. Preserved deliberately during the security migration.
    expect(verdicts.verdictFor('rxjs', MULTI).isResolvedCorrect).toBe(true);

    runTimerStop({
      question,
      clicked: optionNamed(question, 'Observable'),
      isMultipleMode: true,
      allCorrectFound: allCorrectFound(question)
    });

    expect(stopSpy).toHaveBeenCalledTimes(1);
  });
});

describe('authority', () => {
  it('the VERDICT is preferred over the local `.correct` read', () => {
    const question = questionAt(0);
    selectOnQuestion(0, ['map']);

    // The fallback would say "not correct" for every option. If the timer still
    // stops, the decision came from the verdict rather than from the bank.
    runTimerStop({
      question,
      clicked: optionNamed(question, 'map'),
      isMultipleMode: false,
      allCorrectFound: false,
      isPristineCorrect: pristineSaysNo
    });

    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it('the verdict also OVERRIDES a fallback that would wrongly stop the timer', () => {
    const question = questionAt(0);
    selectOnQuestion(0, ['Observable']);

    expect(verdicts.verdictForOption('rxjs', SINGLE, 'Observable')).toBe(false);

    // A fallback claiming every option is correct must not win.
    runTimerStop({
      question,
      clicked: optionNamed(question, 'Observable'),
      isMultipleMode: false,
      allCorrectFound: false,
      isPristineCorrect: () => true
    });

    expect(stopSpy).not.toHaveBeenCalled();
  });

  it('the compatibility fallback applies ONLY when no verdict exists', () => {
    const question = questionAt(0);

    // Nothing submitted — the question is idle, so `verdictForOption` is null.
    expect(verdicts.verdictForOption('rxjs', SINGLE, 'map')).toBeNull();

    runTimerStop({
      question,
      clicked: optionNamed(question, 'map'),
      isMultipleMode: false,
      allCorrectFound: false
    });

    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it('an UNSELECTED option carries no verdict and falls back', () => {
    const question = questionAt(1);
    selectOnQuestion(1, ['map']);

    // The verdict service answers only for options the user actually picked.
    expect(verdicts.verdictForOption('rxjs', MULTI, 'filter')).toBeNull();

    runTimerStop({
      question,
      clicked: optionNamed(question, 'filter'),
      isMultipleMode: false,
      allCorrectFound: false
    });

    expect(stopSpy).toHaveBeenCalledTimes(1);
  });
});

describe('shuffle mode', () => {
  it('ignores allCorrectFound and stops only on a correct single-answer click', () => {
    const question = questionAt(1);
    selectOnQuestion(1, ['map', 'filter']);

    // Shuffled multi-answer scoring is owned by SharedOptionComponent, so the
    // interaction service must not stop the timer there.
    runTimerStop({
      question,
      clicked: optionNamed(question, 'filter'),
      isMultipleMode: true,
      allCorrectFound: true,
      isShuffleActive: true
    });

    expect(stopSpy).not.toHaveBeenCalled();
  });

  it('stops on a correct single-answer click while shuffled', () => {
    const question = questionAt(0);
    selectOnQuestion(0, ['map']);

    runTimerStop({
      question,
      clicked: optionNamed(question, 'map'),
      isMultipleMode: false,
      allCorrectFound: false,
      isShuffleActive: true
    });

    expect(stopSpy).toHaveBeenCalledTimes(1);
  });
});
