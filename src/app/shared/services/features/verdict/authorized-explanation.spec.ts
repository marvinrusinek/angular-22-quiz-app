import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { SharedOptionExplanationService } from '../shared-option/shared-option-explanation.service';
import { ExplanationTextService } from '../explanation/explanation-text.service';
import { QuestionVerdictService } from './question-verdict.service';
import {
  authorizedExplanation,
  explanationFromVerdict
} from './authorized-correctness';
import { IDLE_VERDICT_STATE } from './question-verdict.types';
import type { QuestionVerdictState } from './question-verdict.types';
import { QuizService } from '../../data/quiz.service';
import { QuizStateService } from '../../state/quizstate.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { API_BASE_URL } from '../../../tokens/api-base-url.token';
import { QuestionType } from '../../../models/question-type.enum';
import type { QuizQuestion } from '../../../models/QuizQuestion.model';
import { answerStateStub } from '../../../testing/answer-state-stub';

/**
 * FET CONTENT IS AUTHORIZED, NOT LOCAL.
 *
 * The Topic Quiz explanation was read straight off `question.explanation` —
 * the bundled `assets/data/quiz.json` — at every point the FET was built. That
 * made the answer key a RENDERING dependency, not merely a correctness one,
 * and it is why the asset could not be deleted even after correctness moved to
 * `/check`.
 *
 * `/check` already returns `explanation` on `resolved` and `expired`, and on
 * nothing else. The verdict service already stored it. Nothing read it.
 *
 * Every fixture below puts a DELIBERATELY WRONG explanation on the local
 * question, so any test that passes by reading the bank fails loudly instead of
 * silently agreeing with the authorized text.
 */

const QUESTION = 'What does the async pipe do?';
const LOCAL_LIE = 'LOCAL BANK TEXT — must never be rendered.';
const AUTHORIZED = 'It subscribes to an observable and marks the component for check.';

function state(patch: Partial<QuestionVerdictState>): QuestionVerdictState {
  return { ...IDLE_VERDICT_STATE, ...patch } as QuestionVerdictState;
}

/** The local bank's copy of the question — with a LIE where the truth should be. */
function localQuestion(type = QuestionType.SingleAnswer): QuizQuestion {
  return {
    questionText: QUESTION,
    explanation: LOCAL_LIE,
    type,
    options: [
      { optionId: 1, text: 'Subscribes for you', value: 1, correct: true },
      { optionId: 2, text: 'Formats a date', value: 2 }
    ]
  } as unknown as QuizQuestion;
}

let service: SharedOptionExplanationService;
let verdictState: QuestionVerdictState;
let questions: QuizQuestion[];

const explanationTextStub = {
  fetBypassForQuestion: new Map<number, boolean>(),
  _fetLocked: false,
  latestExplanation: '',
  latestExplanationIndex: -1,
  _activeIndex: -1,
  shouldDisplayExplanationSig: { set: () => undefined },
  unlockExplanation: () => undefined,
  lockExplanation: () => undefined,
  storeFormattedExplanation: () => undefined,
  setExplanationText: () => undefined,
  setIsExplanationTextDisplayed: () => undefined,
  setShouldDisplayExplanation: () => undefined,
  emitFormatted: () => undefined,
  // Identity formatter: the FET BODY is what these tests are about, not the
  // "Options 1 and 2 are correct because…" prefix the formatter adds.
  formatExplanation: (_q: unknown, _i: number[], text: string) => text
};

beforeEach(() => {
  sessionStorage.clear();
  verdictState = IDLE_VERDICT_STATE;
  questions = [localQuestion()];

  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } },
      { provide: API_BASE_URL, useValue: 'https://api.test/api' },
      { provide: ExplanationTextService, useValue: explanationTextStub },
      { provide: QuizStateService, useValue: { setDisplayState: () => undefined } },
      {
        provide: QuizService,
        useValue: {
          quizId: 'rxjs',
          get questions() { return questions; },
          getQuestionsInDisplayOrder: () => questions,
          isShuffleEnabled: () => false,
          shuffledQuestions: [],
          quizInitialState: [],
          quizDataLoader: { getCanonicalQuestions: () => questions },
          ...answerStateStub()
        }
      },
      {
        provide: SelectedOptionService,
        useValue: {
          getSelectedOptionsForQuestion: () => [],
          getResolutionStatus: () => ({ resolved: true, evaluated: true }),
          uiSelectedTextsForQuestion: () => new Set<string>()
        }
      },
      { provide: QuestionVerdictService, useValue: { verdictFor: () => verdictState } }
    ]
  });

  service = TestBed.inject(SharedOptionExplanationService);
});

/** Ask the FET pipeline for the text it would render at display index 0. */
function fetText(index = 0): string {
  return service.resolveExplanationText({
    resolvedIndex: index,
    question: questions[index] ?? null,
    currentQuestion: questions[index] ?? null,
    quizId: 'rxjs',
    optionBindings: (questions[index]?.options ?? []).map((option, i) => ({
      option, index: i, isSelected: false, isCorrect: null
    })) as never,
    optionsToDisplay: (questions[index]?.options ?? []) as never,
    isMultiMode: false
  });
}

describe('the authorized-explanation accessor', () => {
  it('answers only on a terminal phase', () => {
    expect(explanationFromVerdict(state({ phase: 'resolved', explanation: AUTHORIZED }))).toBe(AUTHORIZED);
    expect(explanationFromVerdict(state({ phase: 'expired', explanation: AUTHORIZED }))).toBe(AUTHORIZED);
  });

  it('returns NULL — never a local read — before authorization', () => {
    for (const phase of ['idle', 'checking', 'incomplete', 'error'] as const) {
      expect(explanationFromVerdict(state({ phase, explanation: AUTHORIZED }))).toBeNull();
    }
  });

  it('treats a blank authorized explanation as unauthorized, not as empty text', () => {
    expect(explanationFromVerdict(state({ phase: 'resolved', explanation: '   ' }))).toBeNull();
    expect(explanationFromVerdict(state({ phase: 'resolved', explanation: null }))).toBeNull();
  });

  it('resolves by DISPLAY index, so shuffle cannot cross-wire questions', () => {
    const other = { ...localQuestion(), questionText: 'A different question' } as QuizQuestion;
    questions = [other, localQuestion()];

    const byText = new Map<string, QuestionVerdictState>([
      ['A different question', state({ phase: 'resolved', explanation: 'FIRST' })],
      [QUESTION, state({ phase: 'resolved', explanation: 'SECOND' })]
    ]);
    const verdicts = {
      verdictFor: (_quizId: string, text: string) => byText.get(text) ?? IDLE_VERDICT_STATE
    } as never;
    const quizService = TestBed.inject(QuizService);

    expect(authorizedExplanation(quizService, 0, verdicts)).toBe('FIRST');
    expect(authorizedExplanation(quizService, 1, verdicts)).toBe('SECOND');
  });
});

describe('the FET renders the AUTHORIZED text, never the local bank', () => {
  it('renders the verdict explanation when the local one says otherwise', () => {
    verdictState = state({ phase: 'resolved', explanation: AUTHORIZED });

    const text = fetText();
    expect(text).toContain(AUTHORIZED);
    expect(text).not.toContain(LOCAL_LIE);
  });

  it('renders the verdict explanation on TIMER EXPIRY too', () => {
    // The expiry reveal is authorized by the signed deadline rather than by an
    // answer, and it carries the same explanation field.
    verdictState = state({ phase: 'expired', explanation: AUTHORIZED });

    const text = fetText();
    expect(text).toContain(AUTHORIZED);
    expect(text).not.toContain(LOCAL_LIE);
  });

  it('renders NOTHING while the verdict is unevaluated, even though local text exists', () => {
    // The property that actually unblocks Stage 14: a question the user has not
    // earned must not display bundled explanation text.
    for (const phase of ['idle', 'checking', 'incomplete', 'error'] as const) {
      verdictState = state({ phase, explanation: AUTHORIZED });
      expect(fetText()).toBe('');
    }
  });

  it('renders nothing when a TERMINAL verdict carries no explanation', () => {
    // Fail closed. A terminal response missing its explanation is a server
    // problem; answering it from the bundled asset would hide that AND
    // reintroduce the dependency.
    verdictState = state({ phase: 'resolved', explanation: null });
    expect(fetText()).toBe('');

    verdictState = state({ phase: 'expired', explanation: '' });
    expect(fetText()).toBe('');
  });

  it('works with NO local explanation field at all — the post-cutover shape', () => {
    questions = [{
      questionText: QUESTION,
      type: QuestionType.SingleAnswer,
      options: [
        { optionId: 1, text: 'Subscribes for you', value: 1 },
        { optionId: 2, text: 'Formats a date', value: 2 }
      ]
    } as unknown as QuizQuestion];
    verdictState = state({ phase: 'resolved', explanation: AUTHORIZED });

    expect(fetText()).toContain(AUTHORIZED);
  });

  it('holds for every declared type', () => {
    for (const type of [QuestionType.SingleAnswer, QuestionType.TrueFalse, QuestionType.MultipleAnswer]) {
      questions = [localQuestion(type)];
      verdictState = state({ phase: 'resolved', explanation: AUTHORIZED });

      const text = fetText();
      expect(text).toContain(AUTHORIZED);
      expect(text).not.toContain(LOCAL_LIE);
    }
  });

  it('renders nothing when there are no options to display and nothing authorized', () => {
    // One of the two early exits that used to return `question.explanation`.
    questions = [{ ...localQuestion(), options: [] } as unknown as QuizQuestion];
    verdictState = state({ phase: 'checking' });

    expect(service.resolveExplanationText({
      resolvedIndex: 0,
      question: questions[0]!,
      currentQuestion: questions[0]!,
      quizId: 'rxjs',
      optionBindings: [] as never,
      optionsToDisplay: [] as never,
      isMultiMode: false
    })).toBe('');
  });

  it('uses the verdict on that same no-options path once authorized', () => {
    questions = [{ ...localQuestion(), options: [] } as unknown as QuizQuestion];
    verdictState = state({ phase: 'resolved', explanation: AUTHORIZED });

    expect(service.resolveExplanationText({
      resolvedIndex: 0,
      question: questions[0]!,
      currentQuestion: questions[0]!,
      quizId: 'rxjs',
      optionBindings: [] as never,
      optionsToDisplay: [] as never,
      isMultiMode: false
    })).toBe(AUTHORIZED);
  });
});

describe('nothing is written to browser storage', () => {
  it('does not persist the authorized explanation', () => {
    // Verdict authority is memory-only BY DESIGN — persisting it would rebuild
    // an answer bank in browser storage, which is what the migration removes.
    verdictState = state({ phase: 'resolved', explanation: AUTHORIZED });
    fetText();

    const dump = JSON.stringify({
      local: { ...localStorage },
      session: { ...sessionStorage }
    });
    expect(dump).not.toContain(AUTHORIZED);
  });
});
