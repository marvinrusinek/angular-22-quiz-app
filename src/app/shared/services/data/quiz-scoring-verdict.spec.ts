import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { of, throwError } from 'rxjs';

import { QuizScoringService } from './quiz-scoring.service';
import { QuizService } from './quiz.service';
import { QuestionVerdictService } from '../features/verdict/question-verdict.service';
import { TOPIC_QUIZ_VERDICT_ADAPTER, type TopicQuizVerdictAdapter } from '../features/verdict/verdict-adapter';
import { QuestionVerdictError } from '../features/verdict/question-verdict.types';
import { SelectedOptionService } from '../state/selectedoption.service';
import { setQuizDataCache } from '../../quiz-data-cache';
import type { Quiz } from '../../models/Quiz.model';

/**
 * SCORING FROM VERDICT STATE (Stage 10I).
 *
 * The multi-answer scoring gates asked "has every correct option been
 * selected?" and answered it by scanning the local bank — an answer-key read
 * that also had to guess which source question a display index referred to
 * under shuffle, then cross-validate to recover.
 *
 * That is precisely the SUPERSET rule the verdict already decides, keyed by
 * question TEXT so there is nothing to guess. These tests pin that the verdict
 * is consulted first, and — the mandatory proof — that it WINS when the local
 * flags disagree with it.
 */

const QUIZ = 'rxjs';
const MULTI = 'Select every operator';

// The local bank lies: 'Observable' is flagged correct but is not; 'filter' is
// genuinely required but carries no flag.
const QUESTIONS = [
  {
    questionText: MULTI,
    explanation: 'local explanation',
    options: [
      { text: 'map', correct: true },
      { text: 'filter' },                     // truly correct
      { text: 'Observable', correct: true }    // NOT correct
    ]
  }
];

const BANK = [
  { quizId: QUIZ, milestone: 'RxJS', questions: QUESTIONS }
] as unknown as Quiz[];

if (typeof (globalThis as any).structuredClone !== 'function') {
  (globalThis as any).structuredClone = (value: unknown) => JSON.parse(JSON.stringify(value));
}

/** The genuine correct set — deliberately NOT what the bank's flags say. */
const TRUE_CORRECT = ['map', 'filter'];

const canon = (t: string) => t.trim().toLowerCase();

/**
 * A verdict source that disagrees with the local bank.
 *
 * Applies the same superset rule the backend does, over TRUE_CORRECT.
 */
function stubAdapter(): TopicQuizVerdictAdapter {
  const evaluate = (selectedOptionTexts: readonly string[]) => {
    const selected = new Set(selectedOptionTexts.map(canon));
    const missing = TRUE_CORRECT.filter((t) => !selected.has(canon(t)));

    if (missing.length === 0 && selected.size > 0) {
      return {
        status: 'resolved' as const,
        correct: true,
        correctOptionTexts: TRUE_CORRECT,
        explanation: 'authorized explanation'
      };
    }
    return {
      status: 'incomplete' as const,
      selectedVerdicts: [...selected].map((text) => ({
        text, correct: TRUE_CORRECT.some((t) => canon(t) === text)
      })),
      remainingCorrectCount: missing.length
    };
  };

  return {
    check: (_quizId, _questionText, texts) => {
      if (texts.some((t) => !QUESTIONS[0]!.options.some((o) => canon(o.text) === canon(t)))) {
        return throwError(() => new QuestionVerdictError('Invalid submission'));
      }
      return of(evaluate(texts));
    },
    revealExpired: () => of({
      status: 'expired' as const,
      correctOptionTexts: TRUE_CORRECT,
      explanation: 'authorized explanation'
    })
  };
}

let scoring: QuizScoringService;
let verdicts: QuestionVerdictService;
let quizService: QuizService;
let selectedOptionService: SelectedOptionService;

/** The gate under test, reached through its public entry point. */
const creditable = (extra?: Set<string>) =>
  scoring.isLeavingQuestionCreditable(0, QUIZ, 0, extra);

/** Record a verdict the way the live click path does. */
const submit = (texts: string[]) =>
  selectedOptionService.setUiSelectedTextsForQuestion(0, texts);

beforeEach(() => {
  setQuizDataCache(JSON.parse(JSON.stringify(BANK)) as Quiz[], []);

  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      // A stub adapter is REQUIRED to prove authority. The local adapter derives
      // its verdicts from the same bank the scoring gate used to scan, so the
      // two can never disagree and any "verdict wins" assertion would pass
      // vacuously. This one states the TRUE correct set, which the bank's flags
      // deliberately contradict.
      { provide: TOPIC_QUIZ_VERDICT_ADAPTER, useValue: stubAdapter() },
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } }
    ]
  });

  quizService = TestBed.inject(QuizService);
  (quizService as any).quizId = QUIZ;
  // Stated explicitly through the setter. These specs used to set only the
  // SIGNAL and let QuizService's constructor seed the backing array from the
  // mocked bank. S4 removed that constructor-time seed (it was handing every
  // session the FIRST quiz in the bank regardless of route), so a spec that
  // needs questions now has to say so.
  quizService.questions = JSON.parse(JSON.stringify(QUESTIONS)) as never;

  scoring = TestBed.inject(QuizScoringService);
  verdicts = TestBed.inject(QuestionVerdictService);
  selectedOptionService = TestBed.inject(SelectedOptionService);
});

afterEach(() => setQuizDataCache([], []));

describe('multi-answer credit follows the verdict', () => {
  it('a PARTIAL selection is not creditable', () => {
    submit(['map']);
    expect(verdicts.verdictFor(QUIZ, MULTI).phase).toBe('incomplete');
    expect(creditable()).toBe(false);
  });

  it('an INCORRECT-ONLY selection is not creditable', () => {
    submit(['Observable']);
    expect(creditable()).toBe(false);
  });

  it('selecting every correct option IS creditable', () => {
    submit(['map', 'filter']);
    expect(verdicts.verdictFor(QUIZ, MULTI).isResolvedCorrect).toBe(true);
    expect(creditable()).toBe(true);
  });

  it('SUPERSET: all correct plus an incorrect pick is still creditable', () => {
    // The exact behaviour the migration must not change. Topic Quizzes credit
    // correctSet ⊆ selectedSet; Interview Mode is exact-set and out of scope.
    submit(['map', 'filter', 'Observable']);
    expect(creditable()).toBe(true);
  });
});

describe('the verdict overrules the local answer key', () => {
  it('selecting the locally-flagged set is NOT creditable when the verdict says incomplete', () => {
    // 'map' + 'Observable' is what a local `.correct` scan would call complete —
    // both carry correct: true. The verdict knows 'filter' is still missing.
    expect(QUESTIONS[0]!.options[2]!.correct).toBe(true);

    submit(['map', 'Observable']);

    expect(verdicts.verdictFor(QUIZ, MULTI).phase).toBe('incomplete');
    expect(creditable()).toBe(false);
  });

  it('a set the local flags call INCOMPLETE is creditable when the verdict resolves it', () => {
    // 'filter' carries no local flag, so a scan would never count it.
    expect(QUESTIONS[0]!.options[1]!).not.toHaveProperty('correct');

    submit(['map', 'filter']);

    expect(creditable()).toBe(true);
  });
});

describe('no verdict means NO CREDIT', () => {
  it('an untouched question is not creditable, despite local correct flags', () => {
    // The bank flags 'map' and 'Observable' correct. None of that may credit a
    // question the server never judged — the local scan that used to run here
    // is gone.
    expect(verdicts.verdictFor(QUIZ, MULTI).phase).toBe('idle');
    expect(QUESTIONS[0]!.options[0]!.correct).toBe(true);

    expect(creditable()).toBe(false);
    expect(creditable(new Set(['map', 'Observable']))).toBe(false);
  });

  it('even a selection matching the BANK\'s correct set is not creditable', () => {
    // Exactly what a pristine scan would have called complete.
    expect(creditable(new Set(['map', 'Observable']))).toBe(false);
  });

  it('an ERROR verdict does not credit from the answer key', () => {
    submit(['no such option']);   // rejected by the adapter
    expect(verdicts.verdictFor(QUIZ, MULTI).phase).toBe('error');

    // Falls through to the temporary gate, which cannot see a complete
    // selection either — the important property is that a failed check never
    // produces credit on its own.
    expect(creditable()).toBe(false);
  });
});

describe('shuffle-aware question resolution', () => {
  it('resolves the question through DISPLAY order, not source order', () => {
    const other = {
      questionText: 'Which answer is correct?',
      explanation: 'e',
      options: [{ text: 'A multicast observable', correct: true }, { text: 'A pipe' }]
    };
    // Shuffled: the multi question is displayed at index 0 but is second in
    // the source bank. A source-order lookup would resolve the wrong question.
    (quizService as any).getQuestionsInDisplayOrder = () => [QUESTIONS[0], other];
    quizService.questionsSig.set(
      JSON.parse(JSON.stringify([other, QUESTIONS[0]])) as never
    );

    // Recorded directly against the question TEXT, which is how the verdict is
    // keyed — the point of the test is that the scoring gate resolves display
    // index 0 back to this question rather than to the source-order one.
    verdicts.checkAnswer(QUIZ, MULTI, ['map', 'filter']).subscribe();

    expect(scoring.isLeavingQuestionCreditable(0, QUIZ, 0)).toBe(true);

    // …and display index 1 is the OTHER question, which has no verdict, so it
    // must not inherit this one's credit.
    expect(verdicts.verdictFor(QUIZ, other.questionText).phase).toBe('idle');
  });
});
