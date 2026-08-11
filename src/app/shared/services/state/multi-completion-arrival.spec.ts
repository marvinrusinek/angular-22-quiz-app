import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { SelectedOptionService } from './selectedoption.service';
import { QuizService } from '../data/quiz.service';
import type { QuestionCheckResult } from '../features/verdict/question-verdict.types';
import { API_BASE_URL } from '../../tokens/api-base-url.token';

/**
 * WHERE multi-answer completion comes from.
 *
 * It used to be decided on the click, from a count of correct options taken
 * off the local bank — because under the API adapter the check is still in
 * flight at that moment and the bank was the only thing that could answer. So
 * "this question is finished" was an answer-key claim, not an authorized one.
 *
 * It now arrives with the verdict. These tests drive the arrival handler with
 * real `/check` response shapes and assert the three states move together and
 * only when authorized.
 *
 * The bank in every fixture is EMPTY of correctness — completion still lands,
 * which is the Stage 10J proof for this path.
 */

const Q_MULTI = 'Which are RxJS operators?';
const Q_SINGLE = 'What does an Observable model?';
const Q_OTHER = 'Which decorator marks a component?';

let service: SelectedOptionService;
let quiz: any;

/** Display order differs from canonical, so a positional key would be wrong. */
const DISPLAY_ORDER = [
  { questionText: Q_OTHER,  options: [] },
  { questionText: Q_MULTI,  options: [] },
  { questionText: Q_SINGLE, options: [] }
];
const CANONICAL = [
  { questionText: Q_MULTI,  options: [] },
  { questionText: Q_SINGLE, options: [] },
  { questionText: Q_OTHER,  options: [] }
];

const resolvedMulti = (): QuestionCheckResult => ({
  status: 'resolved',
  correct: true,
  correctOptionTexts: ['map', 'filter'],
  explanation: 'x'
});

const resolvedSingle = (): QuestionCheckResult => ({
  status: 'resolved',
  correct: true,
  correctOptionTexts: ['a stream over time'],
  explanation: 'x'
});

const incomplete = (): QuestionCheckResult => ({
  status: 'incomplete',
  selectedVerdicts: [{ text: 'map', correct: true }],
  remainingCorrectCount: 1
});

const expired = (): QuestionCheckResult => ({
  status: 'expired',
  correctOptionTexts: ['map', 'filter'],
  explanation: 'x'
});

beforeEach(() => {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } },
      { provide: API_BASE_URL, useValue: 'https://api.test/api' },
      {
        provide: QuizService,
        useValue: {
          quizId: 'rxjs',
          // No correctness anywhere in the bank.
          questions: CANONICAL,
          getQuestionsInDisplayOrder: () => DISPLAY_ORDER,
          questionsSig: () => CANONICAL,
          multiAnswerCompletion: new Map<number, boolean>(),
          multiAnswerPerfect: new Map<number, boolean>(),
          questionResolved: new Map<number, boolean>(),
          quizReset$: of(undefined)
        }
      }
    ]
  });

  service = TestBed.inject(SelectedOptionService);
  quiz = TestBed.inject(QuizService);
});

const arrive = (qText: string, submitted: string[], result: QuestionCheckResult | null) =>
  (service as any).applyAuthorizedMultiCompletion(qText, new Set(submitted), result);

/** Q_MULTI sits at display index 1, canonical index 0. */
const MULTI_DISPLAY_IDX = 1;

const completion = (i = MULTI_DISPLAY_IDX) => quiz.multiAnswerCompletion.get(i);
const perfect = (i = MULTI_DISPLAY_IDX) => quiz.multiAnswerPerfect.get(i);
const resolved = (i = MULTI_DISPLAY_IDX) => quiz.questionResolved.get(i);

describe('only an authorized terminal verdict completes a question', () => {
  it('an INCOMPLETE verdict completes nothing', () => {
    arrive(Q_MULTI, ['map'], incomplete());

    expect(completion()).toBeUndefined();
    expect(perfect()).toBeUndefined();
    expect(resolved()).toBeUndefined();
  });

  it('a second partial still completes nothing', () => {
    arrive(Q_MULTI, ['map'], incomplete());
    arrive(Q_MULTI, ['map', 'Subject'], incomplete());

    expect(completion()).toBeUndefined();
  });

  it('an ERROR (no result) completes nothing', () => {
    arrive(Q_MULTI, ['map', 'filter'], null);

    expect(completion()).toBeUndefined();
    expect(resolved()).toBeUndefined();
  });

  it('an error followed by a valid retry completes exactly once', () => {
    arrive(Q_MULTI, ['map', 'filter'], null);
    expect(completion()).toBeUndefined();

    arrive(Q_MULTI, ['map', 'filter'], resolvedMulti());

    expect(completion()).toBe(true);
    expect(resolved()).toBe(true);
  });

  it('EXPIRED is a timeout reveal, not a completion', () => {
    // The user did not earn this by answering; treating it as completion would
    // let the timeout path masquerade as a finished question.
    arrive(Q_MULTI, ['map'], expired());

    expect(completion()).toBeUndefined();
    expect(perfect()).toBeUndefined();
  });
});

describe('completion, perfect and resolved move together', () => {
  it('a resolved multi-answer question completes and resolves', () => {
    arrive(Q_MULTI, ['map', 'filter'], resolvedMulti());

    expect(completion()).toBe(true);
    expect(resolved()).toBe(true);
  });

  it('all correct with nothing wrong is also PERFECT', () => {
    arrive(Q_MULTI, ['map', 'filter'], resolvedMulti());

    expect(perfect()).toBe(true);
  });

  it('SUPERSET: a wrong extra completes but is NOT perfect', () => {
    arrive(Q_MULTI, ['map', 'filter', 'Subject'], resolvedMulti());

    expect(completion()).toBe(true);
    expect(resolved()).toBe(true);
    expect(perfect()).toBeUndefined();
  });

  it('never sets perfect without completion', () => {
    for (const submitted of [['map'], ['map', 'filter'], ['map', 'filter', 'Subject']]) {
      quiz.multiAnswerCompletion.clear();
      quiz.multiAnswerPerfect.clear();
      arrive(Q_MULTI, submitted, resolvedMulti());

      if (perfect() === true) expect(completion()).toBe(true);
    }
  });
});

describe('a single-answer question is not a multi-answer completion', () => {
  it('does not set multiAnswerCompletion when one option is correct', () => {
    // Q_SINGLE is display index 2.
    arrive(Q_SINGLE, ['a stream over time'], resolvedSingle());

    expect(quiz.multiAnswerCompletion.get(2)).toBeUndefined();
    expect(quiz.multiAnswerPerfect.get(2)).toBeUndefined();
  });
});

describe('identity is the question, not its position', () => {
  it('keys by DISPLAY index, resolved from the question text', () => {
    // Q_MULTI is canonical index 0 but display index 1. Writing to 0 would be
    // the documented shuffle bug (perfect flags keyed under the wrong display
    // position, so the FET never shows).
    arrive(Q_MULTI, ['map', 'filter'], resolvedMulti());

    expect(quiz.multiAnswerCompletion.get(1)).toBe(true);
    expect(quiz.multiAnswerCompletion.get(0)).toBeUndefined();
  });

  it('writes nothing for a question that is not on screen', () => {
    arrive('A question from another quiz entirely', ['map', 'filter'], resolvedMulti());

    expect([...quiz.multiAnswerCompletion.keys()]).toEqual([]);
  });
});

describe('repeated delivery is harmless', () => {
  it('a duplicate terminal verdict does not change the outcome', () => {
    arrive(Q_MULTI, ['map', 'filter'], resolvedMulti());
    const after1 = [completion(), perfect(), resolved()];

    arrive(Q_MULTI, ['map', 'filter'], resolvedMulti());
    arrive(Q_MULTI, ['map', 'filter'], resolvedMulti());

    expect([completion(), perfect(), resolved()]).toEqual(after1);
    expect(quiz.multiAnswerCompletion.size).toBe(1);
  });

  it('a stale response for another question cannot complete this one', () => {
    arrive(Q_MULTI, ['map', 'filter'], resolvedMulti());
    // A late response belonging to a DIFFERENT question.
    arrive(Q_OTHER, ['@Component'], resolvedSingle());

    // Q_OTHER is display index 0 and single-answer, so nothing multi is written
    // there, and Q_MULTI's own state is untouched.
    expect(quiz.multiAnswerCompletion.get(0)).toBeUndefined();
    expect(completion()).toBe(true);
  });
});
