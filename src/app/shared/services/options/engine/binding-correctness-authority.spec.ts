import { TestBed } from '@angular/core/testing';

import { OptionBindingFactoryService } from './option-binding-factory.service';
import type { Option } from '../../../models/Option.model';

/**
 * A binding must not claim correctness the user has not earned.
 *
 * The factory used to copy the option's own `correct` flag straight onto the
 * binding, and derive the highlight flags from it too. That made the binding a
 * second answer-key surface: anything downstream reading `binding.isCorrect`
 * was reading `quiz.json`, one hop removed. It also meant a binding built for
 * an option that carries no `correct` flag — the shape `GET /questions`
 * returns — would silently report "not correct" for every option.
 *
 * So construction-time correctness is now `null`: UNKNOWN, distinct from the
 * `false` that means a verdict said wrong. QuestionVerdictService fills it in
 * once an answer or a reveal authorizes it.
 *
 * The fixtures below deliberately LIE. If the factory ever consults the local
 * flag again, these fail.
 */

// jsdom has no structuredClone; the factory clones each option with it.
if (typeof (globalThis as any).structuredClone !== 'function') {
  (globalThis as any).structuredClone = (value: unknown) => JSON.parse(JSON.stringify(value));
}

const cfg = (optionsToDisplay: Option[], type: 'single' | 'multiple' = 'multiple') => ({
  optionsToDisplay,
  type,
  showFeedback: false,
  showFeedbackForOption: {},
  highlightCorrectAfterIncorrect: false,
  shouldResetBackground: false,
  onChange: () => undefined,
  isSelected: (o: Option) => !!o.selected
});

let factory: OptionBindingFactoryService;

beforeEach(() => {
  TestBed.configureTestingModule({ providers: [OptionBindingFactoryService] });
  factory = TestBed.inject(OptionBindingFactoryService);
});

describe('a freshly built binding knows nothing about correctness', () => {
  it('reports unknown even when the option claims to be correct', () => {
    const bindings = factory.createBindings(
      cfg([{ text: 'map', correct: true } as Option])
    );

    expect(bindings[0].isCorrect).toBeNull();
    // Not false — that would mean a verdict had said "wrong".
    expect(bindings[0].isCorrect).not.toBe(false);
  });

  it('reports unknown even when the option claims to be incorrect', () => {
    const bindings = factory.createBindings(
      cfg([{ text: 'Observable', correct: false } as Option])
    );

    expect(bindings[0].isCorrect).toBeNull();
  });

  it('builds successfully from options with NO `correct` property at all', () => {
    // Exactly what GET /questions returns: text and nothing else.
    const bare = [{ text: 'map' }, { text: 'filter' }] as Option[];

    const bindings = factory.createBindings(cfg(bare));

    expect(bindings).toHaveLength(2);
    expect(bindings.map((b) => b.option.text)).toEqual(['map', 'filter']);
    expect(bindings.every((b) => b.isCorrect === null)).toBe(true);
    expect(bindings.every((b) => Object.hasOwn(b, 'isCorrect'))).toBe(true);
  });

  it('never highlights at construction, whatever the option flags say', () => {
    const bindings = factory.createBindings(
      cfg([{ text: 'map', correct: true, selected: true } as Option])
    );

    // Selected AND locally flagged correct — previously enough to paint green
    // before any verdict existed.
    expect(bindings[0].highlightCorrect).toBe(false);
    expect(bindings[0].highlightIncorrect).toBe(false);
  });

  it('still tracks selection, which is not correctness', () => {
    const bindings = factory.createBindings(
      cfg([{ text: 'map', selected: true } as Option, { text: 'filter' } as Option])
    );

    expect(bindings[0].isSelected).toBe(true);
    expect(bindings[1].isSelected).toBe(false);
  });
});

describe('radio vs checkbox follows the declared type, not the answer key', () => {
  it('renders checkboxes for a multiple-answer question with no correct flags', () => {
    const bare = [{ text: 'map' }, { text: 'filter' }] as Option[];

    expect(factory.createBindings(cfg(bare, 'multiple'))[0].appHighlightInputType)
      .toBe('checkbox');
  });

  it('renders radios for a single-answer question even with several correct flags', () => {
    // The count says "multiple"; the declared type says single. The type wins —
    // counting correct options to choose an input control was an answer-key
    // read for a rendering decision.
    const lying = [
      { text: 'map', correct: true },
      { text: 'filter', correct: true }
    ] as Option[];

    expect(factory.createBindings(cfg(lying, 'single'))[0].appHighlightInputType)
      .toBe('radio');
  });
});
