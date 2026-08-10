import { buildHeadingInputs } from './heading-inputs';
import { deriveHeadingHtml, shouldShowFet } from './heading-model';
import { IDLE_VERDICT_STATE, type QuestionVerdictState }
  from '../services/features/verdict/question-verdict.types';

/**
 * Who is allowed to decide the user may read the explanation.
 *
 * The heading used to answer that from the local bank: completion by comparing
 * the user's picks against pristine correct texts, and the wording from the
 * formatter's read of `question.explanation`. So the answer key decided when
 * the user had earned the answer key — and anything that could put text into
 * the explanation stores could put it on screen.
 *
 * Now the verdict decides. It only carries an explanation once terminal, so
 * there is nothing to disclose early even with the whole bank in memory.
 *
 * Every fixture below stocks the LOCAL stores with a give-away explanation.
 * If local data ever becomes an authorization source again, these fail.
 */

const QUESTION = 'Select every operator';
const LOCAL_LEAK = 'LOCAL LEAK — map and filter are correct because they are operators.';
const AUTHORIZED = 'map and filter are correct because they are operators.';

const state = (over: Partial<QuestionVerdictState>): QuestionVerdictState =>
  ({ ...IDLE_VERDICT_STATE, ...over });

/**
 * Deps for a 2-correct-of-4 multi-answer question, with the local explanation
 * stores deliberately primed.
 */
function deps(opts: {
  verdict?: QuestionVerdictState | null;
  selected?: string[];
  localFet?: string;
}) {
  const selected = (opts.selected ?? []).map((text) => ({ text, selected: true }));
  return {
    idx: 0,
    quizService: {
      quizId: 'rxjs',
      getQuestionsInDisplayOrder: () => [{
        questionText: QUESTION,
        options: [{ text: 'map' }, { text: 'filter' }, { text: 'Observable' }, { text: 'Subject' }]
      }],
      questions: [{ questionText: QUESTION }],
      isShuffleEnabled: () => false,
      shuffledQuestions: [],
      getPristineCorrectTextsForQuestion: () => new Set(['map', 'filter']),
      _multiAnswerPerfect: new Map<number, boolean>(),
      multiAnswerCompletion: new Map<number, boolean>()
    },
    explanationTextService: {
      formattedExplanations: { 0: { questionIndex: 0, explanation: opts.localFet ?? LOCAL_LEAK } },
      fetByIndex: new Map<number, string>(),
      timeoutFetByIndex: new Map<number, string>(),
      fetBypassForQuestion: new Map<number, boolean>()
    },
    timerService: { expiredForQuestionIndexSig: () => -1 },
    selectedOptionService: { selectedOptionsMap: new Map([[0, selected]]) },
    quizStateService: {
      hasUserInteracted: () => true,
      wasInteractedThisVisit: () => true
    },
    quizNavigationService: { isNavigatingToPreviousSig: () => false },
    quizQuestionManagerService: { getNumberOfCorrectAnswersText: () => '(2 answers are correct)' },
    questionVerdictService: opts.verdict === null
      ? undefined
      : { verdictFor: () => opts.verdict ?? IDLE_VERDICT_STATE }
  } as any;
}

/** Options rendered, so the cold-load guard in shouldShowFet is satisfied. */
beforeAll(() => {
  document.body.innerHTML = '<div class="option-row"></div><div class="option-row"></div>';
});

describe('a partial multi-answer earns nothing', () => {
  it('does not show the FET when only one of two correct options is selected', () => {
    const i = buildHeadingInputs(deps({
      selected: ['map'],
      verdict: state({
        phase: 'incomplete',
        selectedVerdicts: new Map([['map', true]]),
        remainingCorrectCount: 1
      })
    }))!;

    expect(i.isMultiAnswerComplete).toBe(false);
    expect(shouldShowFet(i)).toBe(false);
    // And the heading shows the question, not the primed local explanation.
    expect(deriveHeadingHtml(i)).not.toContain('LOCAL LEAK');
  });

  it('does not show the FET when the user has picked a WRONG option too', () => {
    const i = buildHeadingInputs(deps({
      selected: ['map', 'Observable'],
      verdict: state({
        phase: 'incomplete',
        selectedVerdicts: new Map([['map', true], ['Observable', false]]),
        remainingCorrectCount: 1
      })
    }))!;

    expect(shouldShowFet(i)).toBe(false);
    expect(deriveHeadingHtml(i)).not.toContain('LOCAL LEAK');
  });
});

describe('a verdict that SAYS not-yet withholds the explanation', () => {
  it('local explanation cannot manufacture a FET against an incomplete verdict', () => {
    // THE PROOF that matters. Every correct option is selected and the bank is
    // holding the explanation, but the verdict says the question is not done —
    // so the local text is present and still never reaches the heading.
    const i = buildHeadingInputs(deps({
      selected: ['map', 'filter'],
      verdict: state({
        phase: 'incomplete',
        selectedVerdicts: new Map([['map', true], ['filter', true]]),
        remainingCorrectCount: 1
      })
    }))!;

    expect(i.fetHtml).toContain('LOCAL LEAK');   // the text exists locally...
    expect(shouldShowFet(i)).toBe(false);        // ...and is still not shown
    expect(deriveHeadingHtml(i)).toBe(i.questionHtml);
  });
});

/**
 * The transitional gap, pinned deliberately rather than hidden.
 *
 * `idle`/`checking`/`error` mean the verdict has said NOTHING — which is not
 * the same as saying "not yet" (see authorized-correctness: absence is not a
 * negative verdict). In those phases the pre-existing pristine comparison
 * still decides, so today's timing is preserved exactly: the FET does not wait
 * for a round trip that may never come.
 *
 * This is the remaining local-authority foothold in the FET path. It closes
 * when the explanation pipeline itself is migrated; until then these tests
 * document it honestly so nobody reads the slice as finished.
 */
describe('TRANSITIONAL: with no verdict at all, the local comparison still decides', () => {
  it.each([['idle'], ['checking'], ['error']] as const)(
    'still shows the FET while %s when the local bank says the question is complete',
    (phase) => {
      const i = buildHeadingInputs(deps({ selected: ['map', 'filter'], verdict: state({ phase }) }))!;

      expect(i.isMultiAnswerComplete).toBe(true);
      expect(shouldShowFet(i)).toBe(true);
    }
  );

  it('still withholds while %s when the local bank says INCOMPLETE', () => {
    // The fallback is not a blanket disclosure: it reproduces the old gate,
    // which itself withholds on a partial selection.
    const i = buildHeadingInputs(deps({ selected: ['map'], verdict: state({ phase: 'idle' }) }))!;

    expect(shouldShowFet(i)).toBe(false);
  });
});

describe('a resolved question is authorized, and the verdict supplies the words', () => {
  it('shows the FET once every correct option is selected', () => {
    const i = buildHeadingInputs(deps({
      selected: ['map', 'filter'],
      verdict: state({
        phase: 'resolved',
        isResolvedCorrect: true,
        correctOptionTexts: ['map', 'filter'],
        explanation: AUTHORIZED
      })
    }))!;

    expect(i.isMultiAnswerComplete).toBe(true);
    expect(shouldShowFet(i)).toBe(true);
    expect(deriveHeadingHtml(i)).toContain('are correct because');
  });

  it('falls back to the verdict wording when the formatter has not produced any', () => {
    // The formatter still composes the prose the user reads ("X and Y are
    // correct because ..."); the verdict carries only the bank's raw sentence.
    // Swapping one for the other would change the copy, so the verdict's text
    // is a last resort — used only so an authorized reveal is never blank.
    const i = buildHeadingInputs(deps({
      selected: ['map', 'filter'],
      localFet: '',
      verdict: state({
        phase: 'resolved',
        isResolvedCorrect: true,
        correctOptionTexts: ['map', 'filter'],
        explanation: AUTHORIZED
      })
    }))!;

    expect(i.fetHtml).toContain(AUTHORIZED);
  });

  it('is authorized by expiry too', () => {
    // Expiry reaches the heading through the TIMER signal, not the verdict
    // phase — the verdict supplies what may be revealed, the timer says the
    // moment arrived. Both are set here, as they are in the live app.
    const d = deps({
      selected: [],
      localFet: '',
      verdict: state({
        phase: 'expired',
        correctOptionTexts: ['map', 'filter'],
        explanation: AUTHORIZED
      })
    });
    d.timerService = { expiredForQuestionIndexSig: () => 0 };
    const i = buildHeadingInputs(d)!;

    expect(i.isTimedOut).toBe(true);
    expect(shouldShowFet(i)).toBe(true);
    expect(i.fetHtml).toContain(AUTHORIZED);
  });
});

describe('callers without a verdict service keep working', () => {
  it('falls back to the pristine comparison when no authority is supplied', () => {
    // The optional dep must not break a caller that predates it.
    const i = buildHeadingInputs(deps({ selected: ['map', 'filter'], verdict: null }))!;

    expect(i.isMultiAnswerComplete).toBe(true);
    expect(shouldShowFet(i)).toBe(true);
  });
});
