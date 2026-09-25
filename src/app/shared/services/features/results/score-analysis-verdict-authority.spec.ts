import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { of, throwError } from 'rxjs';

import { ScoreAnalysisService } from './score-analysis.service';
import { QuestionVerdictService } from '@shared/services/features/verdict/question-verdict.service';
import {
  TOPIC_QUIZ_VERDICT_ADAPTER,
  type TopicQuizVerdictAdapter
} from '@shared/services/features/verdict/verdict-adapter';
import { QuestionVerdictError } from '@shared/services/features/verdict/question-verdict.types';
import { QuizService } from '@shared/services/data/quiz.service';
import { SelectedOptionService } from '@shared/services/state/selectedoption.service';
import { setQuizDataCache } from '@shared/quiz-data-cache';
import type { Quiz } from '@shared/models/Quiz.model';
import type { QuizQuestion } from '@shared/models/QuizQuestion.model';

/**
 * VERDICT AUTHORITY over Results and Review Answers (Stage 10I).
 *
 * `ScoreAnalysisService.buildAnalysis` is the real producer of the review
 * snapshot: `results.component.ts` calls it at completion and persists what it
 * returns into `FinalResult.analysis`. It used to derive correctness from
 * `options.filter(o => o.correct === true)` and would have shown the local
 * `question.explanation`.
 *
 * These tests make the local bank LIE in every direction and assert the review
 * follows the authorized verdict instead. They deliberately do NOT use the
 * local adapter: it derives its verdicts from the same bank, so the two can
 * never disagree and every assertion here would pass vacuously.
 */

const QUIZ = 'rxjs';
const MULTI = 'Select every operator';

const LOCAL_WRONG_EXPLANATION = 'LOCAL WRONG EXPLANATION';
const AUTHORIZED_EXPLANATION = 'AUTHORIZED EXPLANATION';

/** The verdict's view. Deliberately contradicts every local flag below. */
const TRUE_CORRECT = ['filter'];

/**
 * The local bank lies in BOTH directions:
 *   'Observable' is flagged correct   → the verdict says it is not
 *   'filter'     carries no flag      → the verdict says it is correct
 * …and its explanation is wrong.
 */
const QUESTIONS: QuizQuestion[] = [
  {
    questionText: MULTI,
    explanation: LOCAL_WRONG_EXPLANATION,
    options: [
      { optionId: 1, text: 'Observable', correct: true },
      { optionId: 2, text: 'filter' },
      { optionId: 3, text: 'map' }
    ]
  }
] as unknown as QuizQuestion[];

const BANK = [
  { quizId: QUIZ, milestone: 'RxJS', questions: QUESTIONS }
] as unknown as Quiz[];

if (typeof (globalThis as any).structuredClone !== 'function') {
  (globalThis as any).structuredClone = (value: unknown) => JSON.parse(JSON.stringify(value));
}

const canon = (t: string) => t.trim().toLowerCase();

/** A verdict source that disagrees with the bank, applying the superset rule. */
function stubAdapter(): TopicQuizVerdictAdapter {
  const reveal = {
    correctOptionTexts: TRUE_CORRECT,
    explanation: AUTHORIZED_EXPLANATION
  };

  return {
    check: (_quizId, _questionText, texts) => {
      const known = QUESTIONS[0]!.options.map((o) => canon(o.text));
      if (texts.some((t) => !known.includes(canon(t)))) {
        return throwError(() => new QuestionVerdictError('Invalid submission'));
      }

      const selected = new Set(texts.map(canon));
      const missing = TRUE_CORRECT.filter((t) => !selected.has(canon(t)));

      if (missing.length === 0 && selected.size > 0) {
        return of({ status: 'resolved' as const, correct: true, ...reveal });
      }
      return of({
        status: 'incomplete' as const,
        selectedVerdicts: [...selected].map((text) => ({
          text, correct: TRUE_CORRECT.some((t) => canon(t) === text)
        })),
        remainingCorrectCount: missing.length
      });
    },
    revealExpired: () => of({ status: 'expired' as const, ...reveal })
  };
}

let analysisService: ScoreAnalysisService;
let verdicts: QuestionVerdictService;
let selectedOptionService: SelectedOptionService;

/** Record the user's selection the way the live click path does. */
function selectAndRecord(texts: string[]): void {
  selectedOptionService.selectedOptionsMap.set(
    0,
    texts.map((text, i) => ({ optionId: i + 1, text })) as never
  );
  verdicts.checkAnswer(QUIZ, MULTI, texts).subscribe({ error: () => undefined });
}

/** The real producer Results calls at completion. */
const analyse = () => analysisService.buildAnalysis(QUESTIONS)[0]!;

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
  quizService.questionsSig.set(JSON.parse(JSON.stringify(QUESTIONS)) as never);

  analysisService = TestBed.inject(ScoreAnalysisService);
  verdicts = TestBed.inject(QuestionVerdictService);
  selectedOptionService = TestBed.inject(SelectedOptionService);
});

afterEach(() => setQuizDataCache([], []));

describe('Test 1 — the local flag lies TRUE', () => {
  it('a locally-correct option the verdict rejects does not score correct', () => {
    // Sanity: the bank really does claim this option is correct.
    expect(QUESTIONS[0]!.options[0]!.correct).toBe(true);

    selectAndRecord(['Observable']);

    const item = analyse();
    expect(item.wasCorrect).toBe(false);
  });

  it('Review does not list the locally-flagged option as correct', () => {
    selectAndRecord(['filter']);   // resolves, so a reveal is authorized

    const item = analyse();
    expect(item.correctOptionTexts).toEqual(['filter']);
    expect(item.correctOptionTexts).not.toContain('Observable');
  });

  it('the legacy correctOptionIds are derived from the AUTHORIZED texts', () => {
    selectAndRecord(['filter']);

    // 'filter' is optionId 2. Had this come from the local flags it would be 1.
    expect(analyse().correctOptionIds).toEqual(['2']);
  });
});

describe('Test 2 — the local flag lies FALSE', () => {
  it('an option with no local flag scores correct when the verdict says so', () => {
    // Sanity: the bank does NOT flag this option.
    expect(QUESTIONS[0]!.options[1]!).not.toHaveProperty('correct');

    selectAndRecord(['filter']);

    const item = analyse();
    expect(item.wasCorrect).toBe(true);
    expect(item.correctOptionTexts).toContain('filter');
  });

  it('selecting only the locally-flagged option is NOT credited', () => {
    selectAndRecord(['Observable']);
    expect(analyse().wasCorrect).toBe(false);
  });
});

describe('Test 3 — the local explanation lies', () => {
  it('Review shows the AUTHORIZED explanation', () => {
    selectAndRecord(['filter']);

    const item = analyse();
    expect(item.explanation).toBe(AUTHORIZED_EXPLANATION);
  });

  it('the local explanation never appears anywhere in the analysis', () => {
    selectAndRecord(['filter']);

    expect(JSON.stringify(analyse())).not.toContain(LOCAL_WRONG_EXPLANATION);
  });

  it('the timeout reveal also supplies the authorized explanation', () => {
    verdicts.revealExpiredQuestion(QUIZ, MULTI).subscribe();

    const item = analyse();
    expect(item.explanation).toBe(AUTHORIZED_EXPLANATION);
    expect(item.correctOptionTexts).toEqual(['filter']);
  });
});

describe('unauthorized states reveal nothing', () => {
  it('an INCOMPLETE question does not expose a correct set from the verdict', () => {
    // Nothing selected that resolves it — the correct set must not leak.
    selectAndRecord(['map']);
    expect(verdicts.verdictFor(QUIZ, MULTI).phase).toBe('incomplete');

    // No terminal verdict, so the producer has no authorized reveal to use.
    // It falls back to the bank today; what matters is that the VERDICT did
    // not disclose the answer for an unfinished question.
    expect(verdicts.verdictFor(QUIZ, MULTI).correctOptionTexts).toEqual([]);
  });

  it('an ERROR verdict yields no authorized explanation', () => {
    selectAndRecord(['no such option']);
    expect(verdicts.verdictFor(QUIZ, MULTI).phase).toBe('error');

    expect(analyse().explanation).toBeNull();
  });
});
