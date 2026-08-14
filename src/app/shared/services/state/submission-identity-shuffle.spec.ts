import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { SelectedOptionService } from './selectedoption.service';
import { QuizService } from '../data/quiz.service';
import { TOPIC_QUIZ_VERDICT_ADAPTER } from '../features/verdict/verdict-adapter';
import { setQuizDataCache } from '../../quiz-data-cache';
import type { Quiz } from '../../models/Quiz.model';

/**
 * THE QUESTION THE SERVER JUDGES MUST BE THE QUESTION THE USER IS LOOKING AT.
 *
 * `submitToVerdictService` receives a DISPLAY index — both callers derive it
 * from the question on screen. It used to turn that into a question identity by
 * indexing `questionsSig()`, which is assigned the shuffled array on some setup
 * paths and the canonical array on others, so under shuffle it could still hold
 * canonical order when an answer was submitted.
 *
 * Measured on the dependency-injection quiz under shuffle:
 *
 *     display 0 showed  "Which of the following statements..."   (Q3)
 *     /check received   "What is Dependency Injection..."        (Q1)
 *
 * Q3's selected option texts were POSTed under Q1's identity, with a receipt
 * bound to Q1. Seven answered questions produced only SIX unique identities:
 * Q1 submitted twice, Q3 never authorized at all. The server judged the wrong
 * question, and one question's answer was never verified — a correctness and
 * authorization defect, not a display bug.
 *
 * Every fixture leaves `questionsSig()` in CANONICAL order while the display
 * order is shuffled, reproducing exactly the condition that hid this.
 */

const QUIZ_ID = 'rxjs';

/** Canonical (authoring) order — the stale source the old code indexed. */
const CANONICAL = ['Q1 what is DI', 'Q2 which benefit', 'Q3 which statements'];

/** What the user actually sees — deliberately a different order. */
const DISPLAY = ['Q3 which statements', 'Q1 what is DI', 'Q2 which benefit'];

const asQuestions = (texts: string[]) =>
  texts.map((questionText) => ({ questionText, options: [{ text: 'a' }, { text: 'b' }] }));

const BANK = [
  { quizId: QUIZ_ID, milestone: 'RxJS', questions: asQuestions(CANONICAL) }
] as unknown as Quiz[];

if (typeof (globalThis as any).structuredClone !== 'function') {
  (globalThis as any).structuredClone = (v: unknown) => JSON.parse(JSON.stringify(v));
}

let submitted: { questionText: string; texts: string[] }[];
let quizService: QuizService;
let selectedOptionService: SelectedOptionService;

/** Captures exactly what identity reaches the authorized check. */
function capturingAdapter() {
  return {
    check: (_quizId: string, questionText: string, texts: readonly string[]) => {
      submitted.push({ questionText, texts: [...texts] });
      return of({ status: 'incomplete', selectedVerdicts: [], remainingCorrectCount: 1 });
    },
    revealExpired: () => of({ status: 'expired', correctOptionTexts: [] })
  };
}

function configure(shuffled: boolean): void {
  setQuizDataCache(JSON.parse(JSON.stringify(BANK)) as Quiz[], []);
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: TOPIC_QUIZ_VERDICT_ADAPTER, useValue: capturingAdapter() },
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } }
    ]
  });

  quizService = TestBed.inject(QuizService);
  (quizService as any).quizId = QUIZ_ID;
  // CANONICAL in the signal; DISPLAY in the shuffled array. The real
  // getQuestionsInDisplayOrder() then returns DISPLAY when shuffle is on.
  quizService.questionsSig.set(asQuestions(CANONICAL) as never);
  (quizService as any).questions = asQuestions(CANONICAL);
  (quizService as any).shuffledQuestions = shuffled ? asQuestions(DISPLAY) : [];
  jest.spyOn(quizService, 'isShuffleEnabled').mockReturnValue(shuffled);

  selectedOptionService = TestBed.inject(SelectedOptionService);
}

/** The real production entry point — not the private helper. */
const answerAt = (displayIndex: number, texts: string[]) =>
  selectedOptionService.setUiSelectedTextsForQuestion(displayIndex, texts);

beforeEach(() => { submitted = []; configure(true); });
afterEach(() => setQuizDataCache([], []));

describe('submitted identity follows the DISPLAYED question (shuffled)', () => {
  it('submits the displayed question at index 0, not canonical Q1', () => {
    // THE REGRESSION. Display 0 shows Q3; canonical 0 is Q1.
    answerAt(0, ['a']);

    expect(submitted).toHaveLength(1);
    expect(submitted[0].questionText).toBe('Q3 which statements');
    expect(submitted[0].questionText).not.toBe('Q1 what is DI');
  });

  it('keeps the same identity across successive multi-answer submissions', () => {
    answerAt(0, ['a']);
    answerAt(0, ['a', 'b']);

    expect(submitted.map((s) => s.questionText))
      .toEqual(['Q3 which statements', 'Q3 which statements']);
    expect(submitted.map((s) => s.texts.length)).toEqual([1, 2]);
  });

  it('submits the real Q1 under its own identity when it is displayed', () => {
    answerAt(1, ['x']);   // display 1 is Q1

    expect(submitted[0].questionText).toBe('Q1 what is DI');
  });

  it('produces one unique identity per question across a full shuffled run', () => {
    answerAt(0, ['a']);
    answerAt(1, ['b']);
    answerAt(2, ['c']);

    const identities = submitted.map((s) => s.questionText);
    expect(new Set(identities).size).toBe(3);
    expect([...identities].sort()).toEqual([...CANONICAL].sort());
  });

  it('maps every display position to the question shown there', () => {
    answerAt(0, ['a']);
    answerAt(1, ['b']);
    answerAt(2, ['c']);

    expect(submitted.map((s) => s.questionText)).toEqual(DISPLAY);
  });

  it('never duplicates a canonical identity', () => {
    answerAt(0, ['a']);
    answerAt(1, ['b']);
    answerAt(2, ['c']);

    const counts = new Map<string, number>();
    for (const s of submitted) counts.set(s.questionText, (counts.get(s.questionText) ?? 0) + 1);
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
  });
});

describe('non-shuffle behaviour is unchanged', () => {
  beforeEach(() => { submitted = []; configure(false); });

  it('submits the canonical question when shuffle is off', () => {
    answerAt(0, ['a']);
    expect(submitted[0].questionText).toBe('Q1 what is DI');
  });

  it('maps every index to its canonical question when shuffle is off', () => {
    answerAt(0, ['a']);
    answerAt(1, ['b']);
    answerAt(2, ['c']);

    expect(submitted.map((s) => s.questionText)).toEqual(CANONICAL);
  });
});

describe('identity resolution failure is not submitted blindly', () => {
  it('submits nothing when the display index has no question', () => {
    answerAt(99, ['a']);
    expect(submitted).toHaveLength(0);
  });
});
