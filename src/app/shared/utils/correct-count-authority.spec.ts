import { buildHeadingInputs } from './heading-inputs';
import { QuestionType } from '../models/question-type.enum';

/**
 * THE CORRECT-COUNT BANNER IS DECLARED METADATA, NOT A LOCAL TALLY.
 *
 * "(N answers are correct)" was drawn by counting `option.correct` in the
 * bundled `assets/data/quiz.json`. That made a piece of the answer key a
 * RENDERING dependency, so the asset could not be deleted even after
 * correctness, completion, type and explanation had all moved to the API.
 *
 * `GET /questions` now declares `correctCount` beside the type, so both facts
 * about a question arrive on the same authoritative load.
 *
 * EVERY FIXTURE HERE MAKES THE LOCAL BANK LIE. If a test could pass by
 * counting `option.correct` it would report the wrong number and fail.
 */

const QUESTION = 'Which statements about the @for block are correct?';

/**
 * Local options whose `correct` flags say THREE — deliberately disagreeing
 * with whatever the registry declares.
 */
function localOptions() {
  return [
    { optionId: 1, text: 'It requires a track expression', correct: true },
    { optionId: 2, text: 'It replaces *ngFor', correct: true },
    { optionId: 3, text: 'It supports @empty', correct: true },
    { optionId: 4, text: 'It is a pipe', correct: false }
  ];
}

/** Minimal deps for buildHeadingInputs — only what the banner path reads. */
function deps(overrides: {
  declaredCount?: number | null;
  registry?: unknown;
  type?: QuestionType;
} = {}) {
  const question = {
    questionText: QUESTION,
    type: overrides.type ?? QuestionType.MultipleAnswer,
    explanation: 'Because the @for block needs a track expression.',
    options: localOptions()
  };

  const registry = 'registry' in overrides
    ? overrides.registry
    : { correctCountOf: () => overrides.declaredCount ?? null };

  return {
    idx: 0,
    quizService: {
      quizId: 'directives',
      getQuestionsInDisplayOrder: () => [question],
      questions: [question],
      isShuffleEnabled: () => false,
      shuffledQuestions: [],
      getPristineCorrectTextsForQuestion: () =>
        new Set(localOptions().filter((o) => o.correct).map((o) => o.text.toLowerCase())),
      isMultiAnswerComplete: () => false
    },
    explanationTextService: {
      formattedExplanations: {},
      fetByIndex: new Map(),
      timeoutFetByIndex: new Map(),
      fetBypassForQuestion: new Map()
    },
    timerService: { expiredForQuestionIndexSig: () => -1, expiredOnArrivalSig: () => -1 },
    selectedOptionService: { selectedOptionsMap: new Map(), uiSelectedTextsForQuestion: () => new Set() },
    quizStateService: {},
    quizNavigationService: { isNavigatingToPreviousSig: () => false },
    quizQuestionManagerService: {
      getNumberOfCorrectAnswersText: (n: number) =>
        n === 1 ? '(1 answer is correct)' : `(${n} answers are correct)`
    },
    topicQuizTypeRegistry: registry
  } as never;
}

const bannerOf = (d: never): string => buildHeadingInputs(d)?.questionHtml ?? '';

describe('the banner uses the DECLARED count, not the local flags', () => {
  it('A. local flags say 3, the API says 1 — the banner says 1', () => {
    expect(bannerOf(deps({ declaredCount: 1 }))).toContain('(1 answer is correct)');
    expect(bannerOf(deps({ declaredCount: 1 }))).not.toContain('3 answers');
  });

  it('B. local flags say 3, the API says 2 — the banner says 2', () => {
    const html = bannerOf(deps({ declaredCount: 2 }));
    expect(html).toContain('(2 answers are correct)');
    expect(html).not.toContain('3 answers');
  });

  it('the declared count is used even when it happens to agree', () => {
    expect(bannerOf(deps({ declaredCount: 3 }))).toContain('(3 answers are correct)');
  });

  it('C. works with NO local `correct` fields at all — the post-cutover shape', () => {
    const d = deps({ declaredCount: 2 }) as unknown as {
      quizService: { getQuestionsInDisplayOrder: () => unknown[] };
    };
    d.quizService.getQuestionsInDisplayOrder = () => [{
      questionText: QUESTION,
      type: QuestionType.MultipleAnswer,
      explanation: 'e',
      options: localOptions().map(({ optionId, text }) => ({ optionId, text }))
    }];

    expect(bannerOf(d as never)).toContain('(2 answers are correct)');
  });
});

describe('the banner survives an EMPTY pristine bank', () => {
  /**
   * THE REAL POST-CUTOVER SHAPE.
   *
   * Every other test here populates `getPristineCorrectTextsForQuestion`, so
   * the banner rendered for a reason nobody was asserting: `isMultiAnswer` was
   * `pristine.length > 1`. Once the bundled bank is gone that set is EMPTY,
   * the question reads as single-answer, and the banner vanishes — with the
   * declared count sitting right there, already fetched and unused.
   *
   * `type` is the authority for single-vs-multiple (declaredIsMultiAnswer);
   * `correctCount` is the authority for how many. Neither needs the bank.
   */
  const withoutPristine = (overrides: Parameters<typeof deps>[0] = {}) => {
    const d = deps(overrides) as unknown as {
      quizService: { getPristineCorrectTextsForQuestion: () => Set<string> };
    };
    d.quizService.getPristineCorrectTextsForQuestion = () => new Set<string>();
    return d as never;
  };

  it('renders the declared count with NO pristine data at all', () => {
    expect(bannerOf(withoutPristine({ declaredCount: 3 }))).toContain('(3 answers are correct)');
  });

  it('a DECLARED single-answer question still renders no banner', () => {
    const html = bannerOf(withoutPristine({ declaredCount: 1, type: QuestionType.SingleAnswer }));
    expect(html).not.toContain('answers are correct');
    expect(html).not.toContain('answer is correct');
  });

  it('FAILS CLOSED: declared multiple but no declared count renders no banner', () => {
    // NB: the question text itself ends "...are correct?", so the assertion
    // has to target the banner's own wording.
    const html = bannerOf(withoutPristine({ declaredCount: null }));
    expect(html).not.toContain('answers are correct');
    expect(html).not.toContain('answer is correct');
  });
});

describe('singular and plural wording are preserved exactly', () => {
  it('1 → singular', () => {
    expect(bannerOf(deps({ declaredCount: 1 }))).toContain('(1 answer is correct)');
  });

  it('2 and 3 → plural', () => {
    expect(bannerOf(deps({ declaredCount: 2 }))).toContain('(2 answers are correct)');
    expect(bannerOf(deps({ declaredCount: 3 }))).toContain('(3 answers are correct)');
  });
});

describe('D. a missing count FAILS CLOSED', () => {
  it('renders NO banner when the registry has no count', () => {
    const html = bannerOf(deps({ declaredCount: null }));
    expect(html).not.toContain('answers are correct');
    expect(html).not.toContain('answer is correct');
    // …and the question itself still renders, so the quiz stays usable.
    expect(html).toContain('@for block');
  });

  it('renders NO banner when the registry is absent entirely', () => {
    const html = bannerOf(deps({ registry: undefined }));
    expect(html).not.toContain('answers are correct');
    expect(html).toContain('@for block');
  });

  it('does NOT reconstruct the count from the local bank in either case', () => {
    // The local flags say three. If any fallback existed, "3 answers are
    // correct" would appear here.
    for (const d of [deps({ declaredCount: null }), deps({ registry: undefined })]) {
      expect(bannerOf(d)).not.toContain('3 answers');
    }
  });
});

describe('F. the count NEVER decides the question type', () => {
  it('a declared MULTIPLE question with correctCount 1 keeps its type and shows 1', () => {
    const inputs = buildHeadingInputs(deps({ declaredCount: 1, type: QuestionType.MultipleAnswer }));
    expect(inputs!.questionHtml).toContain('(1 answer is correct)');
  });

  it('the banner is composed from the count, while `isMultiAnswer` is not', () => {
    // `isMultiAnswer` on the returned inputs drives layout, not the banner
    // text. Changing the declared count must not move it.
    const one = buildHeadingInputs(deps({ declaredCount: 1 }));
    const three = buildHeadingInputs(deps({ declaredCount: 3 }));
    expect(one!.isMultiAnswer).toBe(three!.isMultiAnswer);
  });
});
