import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { SelectionMessageService, SELECT_ALL_THAT_APPLY_MSG } from './selection-message.service';
import { QuestionVerdictService } from '../verdict/question-verdict.service';
import { QuizService } from '../../data/quiz.service';
import { QuestionType } from '../../../models/question-type.enum';
import { API_BASE_URL } from '../../../tokens/api-base-url.token';
import { IDLE_VERDICT_STATE, type QuestionVerdictState } from '../verdict/question-verdict.types';
import type { Option } from '../../../models/Option.model';

/**
 * The multi-answer selection message.
 *
 * The count it shows â€” "Select N more correct answers" â€” is an authorized fact:
 * `remainingCorrectCount` comes from the /check response, which is why it may
 * be shown at all. It is never recomputed from the bank when a verdict exists.
 *
 * These tests pin the stronger property: with a verdict present, the message is
 * produced WITHOUT reading a single `correct` flag. Every fixture below is
 * passed options whose flags are wrong, inverted, or missing entirely, and the
 * message must not move.
 *
 * `null` remaining is deliberately distinct from `0`: "nothing checked yet" is
 * not "nothing left to find", and treating it as 0 would announce completion.
 */

const QUESTION = 'Select every operator';

/** Not exported by the service, so mirrored here deliberately. */
const NEXT_BTN = 'Please click the Next button to continue.';

let service: SelectionMessageService;
let verdictState: QuestionVerdictState;

const state = (over: Partial<QuestionVerdictState>): QuestionVerdictState =>
  ({ ...IDLE_VERDICT_STATE, ...over });

/**
 * Options whose `correct` flags LIE â€” every one is inverted relative to truth
 * (map/filter are really the correct pair).
 */
const lyingOptions = (selected: string[] = []): Option[] =>
  ([
    { optionId: 1, text: 'map', correct: false },
    { optionId: 2, text: 'filter', correct: false },
    { optionId: 3, text: 'Observable', correct: true },
    { optionId: 4, text: 'Subject', correct: true }
  ] as Option[]).map((o) => ({ ...o, selected: selected.includes(o.text) }));

/** Options with no `correct` property at all â€” the shape /questions returns. */
const bareOptions = (selected: string[] = []): Option[] =>
  ([
    { optionId: 1, text: 'map' },
    { optionId: 2, text: 'filter' },
    { optionId: 3, text: 'Observable' },
    { optionId: 4, text: 'Subject' }
  ] as Option[]).map((o) => ({ ...o, selected: selected.includes(o.text) }));

beforeEach(() => {
  verdictState = IDLE_VERDICT_STATE;

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
          questions: [{ questionText: QUESTION }],
          getQuestionsInDisplayOrder: () => [{ questionText: QUESTION }],
          totalQuestions: () => 3,
          currentQuestionIndex: 0,
          quizReset$: of(undefined)
        }
      },
      { provide: QuestionVerdictService, useValue: { verdictFor: () => verdictState } }
    ]
  });
  service = TestBed.inject(SelectionMessageService);
});

const message = (opts: Option[], index = 0) =>
  service.computeFinalMessage({ index, total: 3, qType: QuestionType.MultipleAnswer, opts });

describe('the remaining count comes from the verdict, not the flags', () => {
  it('asks for one more when the verdict says one is outstanding', () => {
    verdictState = state({
      phase: 'incomplete',
      remainingCorrectCount: 1,
      selectedVerdicts: new Map([['map', true]])
    });

    expect(message(lyingOptions(['map']))).toMatch(/Select 1 more correct answer to continue/);
  });

  it('pluralises from the verdict count', () => {
    verdictState = state({
      phase: 'incomplete',
      remainingCorrectCount: 2,
      selectedVerdicts: new Map([['Observable', false]])
    });

    expect(message(lyingOptions(['Observable']))).toMatch(/Select 2 more correct answers/);
  });

  it('announces completion when the verdict says nothing is outstanding', () => {
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: true,
      remainingCorrectCount: 0,
      selectedVerdicts: new Map([['map', true], ['filter', true]])
    });

    // Not the last question (index 0 of 3) â†’ Next.
    expect(message(lyingOptions(['map', 'filter']))).toBe(NEXT_BTN);
  });

  it('produces the same message from options with no `correct` property', () => {
    verdictState = state({
      phase: 'incomplete',
      remainingCorrectCount: 1,
      selectedVerdicts: new Map([['map', true]])
    });

    expect(message(bareOptions(['map']))).toBe(message(lyingOptions(['map'])));
  });

  it('a wrong pick does not reduce the count', () => {
    // The verdict counts only MISSING CORRECT options, so an incorrect pick
    // leaves the number where it was.
    verdictState = state({
      phase: 'incomplete',
      remainingCorrectCount: 2,
      selectedVerdicts: new Map([['Observable', false]])
    });

    expect(message(lyingOptions(['Observable']))).toMatch(/Select 2 more/);
  });

  it('still completes on a correct-plus-wrong selection, per the superset rule', () => {
    verdictState = state({
      phase: 'incomplete',
      remainingCorrectCount: 0,
      selectedVerdicts: new Map([['map', true], ['filter', true], ['Observable', false]])
    });

    expect(message(lyingOptions(['map', 'filter', 'Observable'])))
      .toBe(NEXT_BTN);
  });
});

describe('the count-free prompt before any selection', () => {
  it('does not reveal how many answers there are', () => {
    verdictState = state({ phase: 'idle' });
    const msg = message(lyingOptions([]));

    expect(msg).toBe(SELECT_ALL_THAT_APPLY_MSG);
    expect(msg).not.toMatch(/\d/);
  });

  it('shows it whether or not a verdict exists', () => {
    verdictState = state({ phase: 'incomplete', remainingCorrectCount: 2 });

    expect(message(bareOptions([]))).toBe(SELECT_ALL_THAT_APPLY_MSG);
  });
});

describe('an absent count is not zero', () => {
  it('does not announce completion merely because no verdict was recorded', () => {
    // remainingCorrectCount is null here. Reading that as 0 would say "Next".
    verdictState = state({ phase: 'idle' });

    expect(message(lyingOptions(['map']))).not.toBe(NEXT_BTN);
  });

  it.each([['idle'], ['checking'], ['error']] as const)(
    'falls back to the local count while %s',
    (phase) => {
      verdictState = state({ phase });

      // With no verdict the passed flags are the only source, so the LYING set
      // is used â€” proving the fallback is what runs, and only then.
      // Selected 'Observable' is flagged correct in this fixture, and the other
      // flagged-correct option ('Subject') is unselected â†’ 1 outstanding.
      expect(message(lyingOptions(['Observable']))).toMatch(/Select 1 more/);
    }
  );
});

describe('display order does not matter', () => {
  it('gives the same message when the options are reversed', () => {
    verdictState = state({
      phase: 'incomplete',
      remainingCorrectCount: 1,
      selectedVerdicts: new Map([['map', true]])
    });

    const forward = message(lyingOptions(['map']));
    const reversed = message([...lyingOptions(['map'])].reverse());

    expect(reversed).toBe(forward);
  });
});
