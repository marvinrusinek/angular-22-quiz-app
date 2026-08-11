import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { AnswerSelectionService } from './answer-selection.service';
import { QuizService } from '../../data/quiz.service';
import { API_BASE_URL } from '../../../tokens/api-base-url.token';

/**
 * THE CLICK NO LONGER DECIDES COMPLETION.
 *
 * Two writers used to record multi-answer completion at click time, both by
 * counting correct options in the local bank:
 *
 *   option-ui-sync.scoreMultiAnswerIfPerfect   — pristine quizInitialState
 *   answer-selection.updateScoringAndAnswerSelectedState — isCorrectOptionValue
 *
 * Under the API adapter the check is still in flight on that click, so the bank
 * was the only thing that could answer — which made "this question is finished"
 * an answer-key claim. Completion is now established solely from the authorized
 * verdict, in SelectedOptionService.applyAuthorizedMultiCompletion.
 *
 * These tests feed the click-time writer a bank that says the question is
 * complete and assert it records no completion anyway.
 */

const IDX = 0;

let service: AnswerSelectionService;
let quiz: any;

/** Options whose `correct` flags claim a completed multi-answer question. */
const OPTIONS_CLAIMING_COMPLETE = [
  { optionId: 1, text: 'map', correct: true },
  { optionId: 2, text: 'filter', correct: true },
  { optionId: 3, text: 'Subject', correct: false }
];

const SELECTED_ALL_CORRECT = [
  { optionId: 1, text: 'map', correct: true, selected: true },
  { optionId: 2, text: 'filter', correct: true, selected: true }
];

beforeEach(() => {
  sessionStorage.clear();

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
          questions: [],
          scoreDirectly: () => undefined,
          multiAnswerCompletion: new Map<number, boolean>(),
          multiAnswerPerfect: new Map<number, boolean>(),
          questionResolved: new Map<number, boolean>(),
          quizReset$: of(undefined)
        }
      }
    ]
  });

  service = TestBed.inject(AnswerSelectionService);
  quiz = TestBed.inject(QuizService);
});

const clickWithBankSayingComplete = () =>
  service.updateScoringAndAnswerSelectedState(
    IDX,
    OPTIONS_CLAIMING_COMPLETE as any,
    SELECTED_ALL_CORRECT as any,
    true,   // isMultiAnswer
    true    // complete
  );

describe('the click-time path records no completion', () => {
  it('does not set multiAnswerCompletion even when the bank says every correct option is selected', () => {
    clickWithBankSayingComplete();

    expect(quiz.multiAnswerCompletion.get(IDX)).toBeUndefined();
  });

  it('does not set multiAnswerPerfect either', () => {
    clickWithBankSayingComplete();

    expect(quiz.multiAnswerPerfect.get(IDX)).toBeUndefined();
  });

  it('still records RESOLVED — the user did answer', () => {
    clickWithBankSayingComplete();

    expect(quiz.questionResolved.get(IDX)).toBe(true);
  });

  it('still writes the durable session mirror a revisit rehydrates from', () => {
    clickWithBankSayingComplete();

    expect(sessionStorage.getItem('multi_perfect_' + IDX)).toBe('true');
  });
});

describe('a partial or wrong-only selection is unaffected', () => {
  it('a partial multi-answer selection records nothing', () => {
    service.updateScoringAndAnswerSelectedState(
      IDX,
      OPTIONS_CLAIMING_COMPLETE as any,
      [SELECTED_ALL_CORRECT[0]] as any,
      true,
      false
    );

    expect(quiz.multiAnswerCompletion.get(IDX)).toBeUndefined();
    expect(quiz.questionResolved.get(IDX)).toBeUndefined();
  });

  it('a wrong-only selection records nothing', () => {
    service.updateScoringAndAnswerSelectedState(
      IDX,
      OPTIONS_CLAIMING_COMPLETE as any,
      [{ optionId: 3, text: 'Subject', correct: false, selected: true }] as any,
      true,
      false
    );

    expect(quiz.multiAnswerCompletion.get(IDX)).toBeUndefined();
    expect(quiz.multiAnswerPerfect.get(IDX)).toBeUndefined();
  });
});

describe('with `correct` structurally absent the click still claims nothing', () => {
  it('records no completion when no option carries a correct flag', () => {
    // The shape /questions returns. The old gate counted zero correct options
    // and fell through; the point is that nothing here can claim completion.
    service.updateScoringAndAnswerSelectedState(
      IDX,
      [{ optionId: 1, text: 'map' }, { optionId: 2, text: 'filter' }] as any,
      [{ optionId: 1, text: 'map', selected: true }] as any,
      true,
      true
    );

    expect(quiz.multiAnswerCompletion.get(IDX)).toBeUndefined();
    expect(quiz.multiAnswerPerfect.get(IDX)).toBeUndefined();
  });
});
