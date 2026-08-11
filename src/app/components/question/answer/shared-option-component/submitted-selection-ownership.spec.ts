import { SharedOptionComponent } from './shared-option.component';

/**
 * WHAT THE APP TELLS THE SERVER THE USER SELECTED.
 *
 * `syncUiSelectedTexts` publishes the current question's selected option texts,
 * and that set is what `submitToVerdictService` sends to POST /check. So this
 * function decides the CONTENT OF THE USER'S ANSWER, not just a highlight.
 *
 * It used to count any option carrying `option.highlight`. Auto-reveal — the
 * all-incorrects-exhausted path — paints the correct options with `highlight`
 * while deliberately leaving `selected`/`isSelected` on the clicked option
 * only. So revealing the answers to the user also SUBMITTED them as the user's
 * answer, and the backend correctly returned `resolved` for a question nobody
 * had answered.
 *
 * Measured on DI Q3 (3 correct, 1 wrong):
 *
 *     clicked: the single wrong option
 *     submitted BEFORE: [wrong, correct, correct, correct] -> resolved
 *     submitted AFTER:  [wrong]                            -> incomplete
 *
 * These tests drive the real publisher against a minimal host, because the
 * boundary being defended is this function's own logic.
 */

type Binding = {
  isSelected?: boolean;
  _autoRevealedCorrect?: boolean;
  option: {
    text: string;
    selected?: boolean;
    highlight?: boolean;
    showIcon?: boolean;
    _autoRevealedCorrect?: boolean;
  };
};

/** Invoke the real method with a minimal host and capture what it publishes. */
function publish(bindings: Binding[], revisitSnapshot?: ReadonlySet<string>): string[] {
  let captured: string[] = [];
  const host = {
    getActiveQuestionIndex: () => 2,
    optionBindings: () => bindings,
    selectedOptionService: {
      getRevisitDisplayTexts: () => revisitSnapshot,
      setUiSelectedTextsForQuestion: (_i: number, texts: string[]) => { captured = [...texts]; }
    }
  };
  (SharedOptionComponent.prototype as any).syncUiSelectedTexts.call(host);
  return captured;
}

/** Exactly what applyAutoRevealBindings produces: clicked=wrong, 3 revealed. */
function afterAutoReveal(): Binding[] {
  return [
    {
      isSelected: false, _autoRevealedCorrect: true,
      option: { text: 'DI is a technique', selected: false, highlight: true, showIcon: true, _autoRevealedCorrect: true }
    },
    {
      isSelected: true, _autoRevealedCorrect: false,
      option: { text: 'DI always leads to perf gains', selected: true, highlight: true, showIcon: true }
    },
    {
      isSelected: false, _autoRevealedCorrect: true,
      option: { text: 'DI helps reduce coupling', selected: false, highlight: true, showIcon: true, _autoRevealedCorrect: true }
    },
    {
      isSelected: false, _autoRevealedCorrect: true,
      option: { text: 'DI makes mocking easy', selected: false, highlight: true, showIcon: true, _autoRevealedCorrect: true }
    }
  ];
}

describe('auto-revealed options are not part of the user answer', () => {
  it('submits ONLY the option the user clicked', () => {
    expect(publish(afterAutoReveal())).toEqual(['DI always leads to perf gains']);
  });

  it('excludes every revealed correct option', () => {
    const submitted = publish(afterAutoReveal());

    for (const revealed of ['DI is a technique', 'DI helps reduce coupling', 'DI makes mocking easy']) {
      expect(submitted).not.toContain(revealed);
    }
  });

  it('is not fooled when only the option carries the reveal flag', () => {
    // The binding-level and option-level flags are written together, but the
    // set is the user's answer — either marker must be enough to exclude it.
    const bindings = afterAutoReveal().map((b) => ({ ...b, _autoRevealedCorrect: false }));

    expect(publish(bindings)).toEqual(['DI always leads to perf gains']);
  });
});

describe('genuine user selections still submit', () => {
  it('submits a normally selected option', () => {
    const submitted = publish([
      { isSelected: true, option: { text: 'map', selected: true, highlight: true } },
      { isSelected: false, option: { text: 'Subject', selected: false, highlight: false } }
    ]);

    expect(submitted).toEqual(['map']);
  });

  it('submits every option of a genuinely completed multi-answer question', () => {
    const submitted = publish([
      { isSelected: true, option: { text: 'map', selected: true, highlight: true } },
      { isSelected: false, option: { text: 'Subject', selected: false, highlight: false } },
      { isSelected: true, option: { text: 'filter', selected: true, highlight: true } }
    ]);

    expect(submitted).toEqual(['map', 'filter']);
  });

  it('keeps an earlier pick that only carries `highlight` after a binding rebuild', () => {
    // A previously-clicked WRONG option keeps highlight but is not revealed;
    // dropping it would under-report the user's answer.
    const submitted = publish([
      { isSelected: false, option: { text: 'Subject', selected: false, highlight: true, showIcon: true } },
      { isSelected: true, option: { text: 'map', selected: true, highlight: true } }
    ]);

    expect(submitted).toEqual(['Subject', 'map']);
  });

  it('still submits a correct option the USER picked, even once revealed', () => {
    // Clicked AND revealed: `selected` is true, so it is a real answer.
    const submitted = publish([
      {
        isSelected: true, _autoRevealedCorrect: true,
        option: { text: 'map', selected: true, highlight: true, _autoRevealedCorrect: true }
      }
    ]);

    expect(submitted).toEqual(['map']);
  });
});

describe('the revisit snapshot carries real prior picks', () => {
  it('unions the first-visit selections', () => {
    const submitted = publish(
      [{ isSelected: true, option: { text: 'map', selected: true, highlight: true } }],
      new Set(['filter'])
    );

    expect(submitted).toContain('map');
    expect(submitted).toContain('filter');
  });

  it('does not resurrect revealed options through a rebuild after revisit', () => {
    const submitted = publish(afterAutoReveal(), new Set<string>());

    expect(submitted).toEqual(['DI always leads to perf gains']);
  });
});
