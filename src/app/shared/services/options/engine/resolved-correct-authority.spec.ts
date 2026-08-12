import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { QuestionResolutionService } from './question-resolution.service';
import { QuestionVerdictService } from '../../features/verdict/question-verdict.service';
import { QuizService } from '../../data/quiz.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { API_BASE_URL } from '../../../tokens/api-base-url.token';
import { IDLE_VERDICT_STATE, type QuestionVerdictState } from '../../features/verdict/question-verdict.types';
import { answerStateStub } from '../../../testing/answer-state-stub';

/**
 * "Was this question answered perfectly?" — the gate behind perfect-revisit
 * restore, grey-out and several option-item decisions.
 *
 * It used to answer by rebuilding the correct set from the bank
 * (resolvePristineCorrectOpts -> getPristineQuestionByText) and comparing it
 * against the user's saved selection. That made the answer key the arbiter of
 * an active UI state.
 *
 * The subtlety that makes this more than a swap: "perfect" is STRICTER than the
 * verdict's own correct/incorrect. Topic Quiz resolves multi-answer on the
 * audited SUPERSET rule — correctSet ⊆ selectedSet, extra wrong picks
 * tolerated — so `isResolvedCorrect` alone would call a selection with wrong
 * extras perfect. Perfect additionally requires that nothing wrong was picked.
 *
 * Both halves are authorized: completion from the verdict, "nothing wrong was
 * picked" from the user's own selected verdicts. Neither asks about an option
 * they never touched.
 */

const QUESTION = 'Select every operator';

let service: QuestionResolutionService;
let verdictState: QuestionVerdictState;
let selections: any[];

const state = (over: Partial<QuestionVerdictState>): QuestionVerdictState =>
  ({ ...IDLE_VERDICT_STATE, ...over });

/** The bank claims map+filter are correct — used only by the fallback path. */
const PRISTINE = {
  questionText: QUESTION,
  options: [
    { optionId: 1, text: 'map', correct: true },
    { optionId: 2, text: 'filter', correct: true },
    { optionId: 3, text: 'Observable' },
    { optionId: 4, text: 'Subject' }
  ]
};

beforeEach(() => {
  verdictState = IDLE_VERDICT_STATE;
  selections = [];

  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } },
      { provide: API_BASE_URL, useValue: 'https://api.test/api' },
      QuestionResolutionService,
      {
        provide: QuizService,
        useValue: {
          quizId: 'rxjs',
          getQuestionsInDisplayOrder: () => [PRISTINE],
          questions: [PRISTINE],
          isShuffleEnabled: () => false,
          shuffledQuestions: [],
          getPristineQuestionByText: () => PRISTINE,
          ...answerStateStub(),
          questionCorrectness: new Map<number, boolean>()
        }
      },
      {
        provide: SelectedOptionService,
        useValue: {
          clickConfirmedDotStatus: new Map(),
          getSelectedOptionsForQuestion: () => selections
        }
      },
      { provide: QuestionVerdictService, useValue: { verdictFor: () => verdictState } }
    ]
  });
  service = TestBed.inject(QuestionResolutionService);
});

const picked = (...texts: string[]) =>
  texts.map((text, i) => ({ optionId: i + 1, text, selected: true }));

const resolve = () => service.resolveQuestionState(0, { includeDot: false });

describe('the verdict decides whether a question was answered perfectly', () => {
  it('is perfect when every correct option is picked and nothing wrong is', () => {
    selections = picked('map', 'filter');
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: true,
      correctOptionTexts: ['map', 'filter'],
      selectedVerdicts: new Map([['map', true], ['filter', true]])
    });

    expect(resolve().computedPerfect).toBe(true);
  });

  it('is NOT perfect when a wrong option was also picked, despite a correct verdict', () => {
    // THE SUPERSET TRAP. The verdict resolves correct (correctSet ⊆ selectedSet)
    // but the user also picked a wrong option, so this is not perfect.
    selections = picked('map', 'filter', 'Observable');
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: true,
      correctOptionTexts: ['map', 'filter'],
      selectedVerdicts: new Map([['map', true], ['filter', true], ['Observable', false]])
    });

    const res = resolve();
    expect(res.computedPerfect).toBe(false);
    expect(res.computedImperfect).toBe(true);
  });

  it('is not perfect while the question is incomplete', () => {
    selections = picked('map');
    verdictState = state({
      phase: 'incomplete',
      remainingCorrectCount: 1,
      selectedVerdicts: new Map([['map', true]])
    });

    expect(resolve().computedPerfect).toBe(false);
  });

  it('is not perfect on a wrong-only selection', () => {
    selections = picked('Observable');
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: false,
      selectedVerdicts: new Map([['Observable', false]])
    });

    expect(resolve().computedPerfect).toBe(false);
  });

  it('reports neither perfect nor imperfect when nothing is selected', () => {
    selections = [];
    verdictState = state({ phase: 'incomplete', remainingCorrectCount: 2 });

    const res = resolve();
    expect(res.computedPerfect).toBe(false);
    expect(res.computedImperfect).toBe(false);
  });
});

describe('the local answer key cannot override the verdict', () => {
  it('ignores pristine flags that disagree — verdict says incomplete', () => {
    // The bank says map+filter are the answers and both were picked, so the
    // OLD comparison would have said perfect. The verdict says otherwise.
    selections = picked('map', 'filter');
    verdictState = state({
      phase: 'incomplete',
      remainingCorrectCount: 1,
      selectedVerdicts: new Map([['map', true], ['filter', true]])
    });

    expect(resolve().computedPerfect).toBe(false);
  });

  it('is perfect on options the bank marks WRONG, when the verdict says right', () => {
    selections = picked('Observable', 'Subject');
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: true,
      correctOptionTexts: ['Observable', 'Subject'],
      selectedVerdicts: new Map([['Observable', true], ['Subject', true]])
    });

    expect(resolve().computedPerfect).toBe(true);
  });
});

describe('with no verdict, the existing comparison still answers', () => {
  it.each([['idle'], ['checking'], ['error']] as const)(
    'falls back to the pristine comparison while %s',
    (phase) => {
      // Absence of a verdict is not a negative one — a revisit in a fresh
      // session must still restore correctly.
      selections = picked('map', 'filter');
      verdictState = state({ phase });

      expect(resolve().computedPerfect).toBe(true);
    }
  );

  it('still reports imperfect for a partial selection with no verdict', () => {
    selections = picked('map');
    verdictState = state({ phase: 'idle' });

    const res = resolve();
    expect(res.computedPerfect).toBe(false);
    expect(res.computedImperfect).toBe(true);
  });
});

describe('identity is textual', () => {
  it('does not depend on the order the options were selected in', () => {
    selections = picked('filter', 'map');   // reversed
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: true,
      correctOptionTexts: ['map', 'filter'],
      selectedVerdicts: new Map([['map', true], ['filter', true]])
    });

    expect(resolve().computedPerfect).toBe(true);
  });
});
