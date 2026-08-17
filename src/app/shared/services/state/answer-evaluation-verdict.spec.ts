import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { of, throwError } from 'rxjs';

import { AnswerEvaluationService } from './answer-evaluation.service';
import { SelectedOptionService } from './selectedoption.service';
import { QuestionVerdictService } from '../features/verdict/question-verdict.service';
import {
  TOPIC_QUIZ_VERDICT_ADAPTER,
  type TopicQuizVerdictAdapter
} from '../features/verdict/verdict-adapter';
import { QuestionVerdictError } from '../features/verdict/question-verdict.types';
import { QuizService } from '../data/quiz.service';
import { setQuizDataCache } from '../../quiz-data-cache';
import type { Quiz } from '../../models/Quiz.model';
import type { QuizQuestion } from '../../models/QuizQuestion.model';

/**
 * RESOLUTION STATUS from verdict state.
 *
 * `getResolutionStatus` used to scan `option.correct` (via
 * `resolveAuthoritativeOptions`) whenever no verdict existed. That made absence
 * of a verdict mean "ask the answer bank", when it should mean "not evaluated".
 *
 * The distinction matters beyond security: unanswered and answered-entirely-
 * wrongly both produce zero correct selections, and only `evaluated` separates
 * them.
 *
 * The bank below LIES in both directions, so any reversion to local correctness
 * fails these tests rather than passing quietly.
 */

const QUIZ = 'rxjs';
const MULTI = 'Select every operator';

/** The verdict's view — deliberately not what the local flags say. */
const TRUE_CORRECT = ['filter', 'map'];

const QUESTIONS: QuizQuestion[] = [
  {
    questionText: MULTI,
    explanation: 'local explanation',
    options: [
      { optionId: 1, text: 'map', correct: true },
      { optionId: 2, text: 'filter' },                    // truly correct
      { optionId: 3, text: 'Observable', correct: true }   // NOT correct
    ]
  }
] as unknown as QuizQuestion[];

const BANK = [{ quizId: QUIZ, milestone: 'RxJS', questions: QUESTIONS }] as unknown as Quiz[];

if (typeof (globalThis as any).structuredClone !== 'function') {
  (globalThis as any).structuredClone = (value: unknown) => JSON.parse(JSON.stringify(value));
}

const canon = (t: string) => t.trim().toLowerCase();

function stubAdapter(): TopicQuizVerdictAdapter {
  return {
    check: (_q, _t, texts) => {
      const known = QUESTIONS[0]!.options.map((o) => canon(o.text));
      if (texts.some((t) => !known.includes(canon(t)))) {
        return throwError(() => new QuestionVerdictError('Invalid submission'));
      }
      const selected = new Set(texts.map(canon));
      const missing = TRUE_CORRECT.filter((t) => !selected.has(canon(t)));

      if (missing.length === 0 && selected.size > 0) {
        return of({
          status: 'resolved' as const, correct: true,
          correctOptionTexts: TRUE_CORRECT, explanation: 'AUTHORIZED'
        });
      }
      return of({
        status: 'incomplete' as const,
        selectedVerdicts: [...selected].map((text) => ({
          text, correct: TRUE_CORRECT.some((t) => canon(t) === text)
        })),
        remainingCorrectCount: missing.length
      });
    },
    revealExpired: () => of({
      status: 'expired' as const, correctOptionTexts: TRUE_CORRECT, explanation: 'AUTHORIZED'
    })
  };
}

let evaluation: AnswerEvaluationService;
let verdicts: QuestionVerdictService;
let selectedOptionService: SelectedOptionService;

const question = () => QUESTIONS[0]!;
const status = () => evaluation.getResolutionStatus(question(), [] as never, false);

const submit = (texts: string[]) =>
  selectedOptionService.setUiSelectedTextsForQuestion(0, texts);

beforeEach(() => {
  setQuizDataCache(JSON.parse(JSON.stringify(BANK)) as Quiz[], []);

  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: TOPIC_QUIZ_VERDICT_ADAPTER, useValue: stubAdapter() },
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } }
    ]
  });

  const quizService = TestBed.inject(QuizService);
  (quizService as any).quizId = QUIZ;
  // Stated explicitly through the setter. These specs used to set only the
  // SIGNAL and let QuizService's constructor seed the backing array from the
  // mocked bank. S4 removed that constructor-time seed (it was handing every
  // session the FIRST quiz in the bank regardless of route), so a spec that
  // needs questions now has to say so.
  quizService.questions = JSON.parse(JSON.stringify(QUESTIONS)) as never;

  evaluation = TestBed.inject(AnswerEvaluationService);
  verdicts = TestBed.inject(QuestionVerdictService);
  selectedOptionService = TestBed.inject(SelectedOptionService);
});

afterEach(() => setQuizDataCache([], []));

describe('unanswered means unanswered', () => {
  it('an untouched question is UNEVALUATED, not "zero correct"', () => {
    expect(verdicts.verdictFor(QUIZ, MULTI).phase).toBe('idle');

    const result = status();
    expect(result.evaluated).toBe(false);
    expect(result.resolved).toBe(false);
    // The bank flags two options correct. None of that may surface.
    expect(result.correctTotal).toBe(0);
  });

  it('an ERROR verdict is unevaluated, not scored from the bank', () => {
    submit(['no such option']);
    expect(verdicts.verdictFor(QUIZ, MULTI).phase).toBe('error');

    const result = status();
    expect(result.evaluated).toBe(false);
    expect(result.resolved).toBe(false);
  });
});

describe('the verdict overrules the local bank', () => {
  it('the locally-flagged set does NOT resolve when the verdict says incomplete', () => {
    // 'map' + 'Observable' both carry correct: true locally, so a bank scan
    // would call this complete. The verdict knows 'filter' is required.
    submit(['map', 'Observable']);

    const result = status();
    expect(result.evaluated).toBe(true);
    expect(result.resolved).toBe(false);
    expect(result.remainingCorrect).toBe(1);
    // Counts follow the verdict: 'Observable' is wrong despite its flag.
    expect(result.correctSelected).toBe(1);
    expect(result.incorrectSelected).toBe(1);
  });

  it('a set the bank calls incomplete DOES resolve when the verdict says so', () => {
    // 'filter' carries no local flag at all.
    submit(['map', 'filter']);

    const result = status();
    expect(result.evaluated).toBe(true);
    expect(result.resolved).toBe(true);
    expect(result.correctTotal).toBe(2);
    expect(result.remainingCorrect).toBe(0);
  });

  it('SUPERSET: all correct plus an incorrect pick still resolves', () => {
    submit(['map', 'filter', 'Observable']);

    const result = status();
    expect(result.resolved).toBe(true);
    expect(result.incorrectSelected).toBe(1);
  });

  it('STRICT mode still rejects a superset selection', () => {
    submit(['map', 'filter', 'Observable']);

    // strict=true means "no incorrect selections" — preserved from the old
    // local implementation.
    expect(evaluation.getResolutionStatus(question(), [] as never, true).resolved).toBe(false);
  });
});

describe('partial selections', () => {
  it('one correct pick is incomplete with the remaining count from the verdict', () => {
    submit(['filter']);

    const result = status();
    expect(result.resolved).toBe(false);
    expect(result.correctSelected).toBe(1);
    expect(result.remainingCorrect).toBe(1);
    expect(result.correctTotal).toBe(2);
  });

  it('an incorrect-only pick is incomplete and credits nothing', () => {
    submit(['Observable']);

    const result = status();
    expect(result.resolved).toBe(false);
    expect(result.correctSelected).toBe(0);
    expect(result.incorrectSelected).toBe(1);
    expect(result.remainingCorrect).toBe(2);
  });
});

describe('isQuestionComplete follows the verdict', () => {
  /** The method only checks that SOMETHING is selected; counts come from the verdict. */
  const anySelection = [{ optionId: 1, text: 'map' }] as never;
  const isComplete = () => evaluation.isQuestionComplete(question(), anySelection);

  it('an UNTOUCHED question is not complete, despite local correct flags', () => {
    expect(QUESTIONS[0]!.options[0]!.correct).toBe(true);
    expect(verdicts.verdictFor(QUIZ, MULTI).phase).toBe('idle');

    expect(isComplete()).toBe(false);
  });

  it('an EMPTY selection is not complete', () => {
    submit(['map', 'filter']);   // verdict resolves…
    expect(evaluation.isQuestionComplete(question(), [] as never)).toBe(false);
  });

  it('the locally-flagged set is NOT complete when the verdict says incomplete', () => {
    // 'map' + 'Observable' both carry correct: true locally.
    submit(['map', 'Observable']);
    expect(isComplete()).toBe(false);
  });

  it('a set the bank calls incomplete IS complete when the verdict resolves it', () => {
    // 'filter' carries no local flag.
    submit(['map', 'filter']);
    expect(isComplete()).toBe(true);
  });

  it('an ERROR verdict is not complete and does not consult the bank', () => {
    submit(['no such option']);
    expect(verdicts.verdictFor(QUIZ, MULTI).phase).toBe('error');
    expect(isComplete()).toBe(false);
  });

  it('EXACT-SET is preserved: superset resolves but does not COMPLETE', () => {
    // The historical contract. Scoring credits a superset; completion does not.
    submit(['map', 'filter', 'Observable']);

    expect(status().resolved).toBe(true);          // scoring rule
    expect(isComplete()).toBe(false);              // completion rule
  });

  it('a partial selection is not complete', () => {
    submit(['filter']);
    expect(isComplete()).toBe(false);
  });

  it('an incorrect-only selection is not complete', () => {
    submit(['Observable']);
    expect(isComplete()).toBe(false);
  });
});

describe('timeout', () => {
  it('an expired question is evaluated but not credited', () => {
    verdicts.revealExpiredQuestion(QUIZ, MULTI).subscribe();

    const result = status();
    expect(result.evaluated).toBe(true);
    // Expiry reveals the answer; it does not award the question.
    expect(result.resolved).toBe(false);
    expect(result.correctTotal).toBe(2);
  });
});
