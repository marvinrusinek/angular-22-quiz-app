import { Option } from '@shared/models';
import { AnswerComponent } from './answer.component';

/**
 * syncOptionsWithSelections(): restores saved selections onto the displayed
 * options (revisit / refresh) and, for single-answer questions, points the
 * radio group at the matched option's POSITION.
 *
 * The method only touches a handful of members, so it is run against a small
 * stand-in for `this` instead of building the whole component (which needs
 * the BaseQuestion dependency graph). No template or DI is involved.
 */
describe('AnswerComponent.syncOptionsWithSelections', () => {
  type Saved = { optionId?: number | string | null; text?: string };

  const opt = (optionId: number | null | undefined, text: string): Option =>
    ({ optionId, text, selected: false }) as unknown as Option;

  function run(config: {
    options: Option[];
    saved?: Saved[] | null;
    type?: 'single' | 'multiple';
    questionIndex?: number | null | undefined;
    withForm?: boolean;
  }) {
    const patchValue = jest.fn();
    const setBindings = jest.fn();
    const hydrate = jest.fn(() => ['hydrated']);
    const bindings = Object.assign(() => ['existing'], { set: setBindings });
    const fake = {
      currentQuestionIndex: () =>
        'questionIndex' in config ? config.questionIndex : 2,
      selectedOptionService: {
        getSelectedOptionsForQuestion: jest.fn(() => config.saved)
      },
      optionsToDisplay: () => config.options,
      type: () => config.type ?? 'single',
      optionBindings: bindings,
      answerBindingsService: { hydrateBindingsFromSavedSelections: hydrate },
      form: () => (config.withForm === false ? undefined : { patchValue })
    };

    (AnswerComponent.prototype as any)['syncOptionsWithSelections'].call(fake);

    return { patchValue, setBindings, hydrate, fake, selected: () => config.options.map((o) => o.selected) };
  }

  const abc = () => [opt(1, 'Alpha'), opt(2, 'Beta'), opt(3, 'Gamma')];

  describe('single-answer', () => {
    it('restores the selection by option ID and records its POSITION', () => {
      const r = run({ options: abc(), saved: [{ optionId: 2, text: 'no text match' }] });
      expect(r.selected()).toEqual([false, true, false]);
      expect(r.patchValue).toHaveBeenCalledTimes(1);
      expect(r.patchValue).toHaveBeenCalledWith({ selectedOptionId: 1 }, { emitEvent: false });
    });

    it('records the position, not the optionId, when they differ', () => {
      const options = [opt(10, 'A'), opt(20, 'B'), opt(30, 'C')];
      const r = run({ options, saved: [{ optionId: 30 }] });
      expect(r.selected()).toEqual([false, false, true]);
      expect(r.patchValue).toHaveBeenCalledWith({ selectedOptionId: 2 }, { emitEvent: false });
    });

    it('restores by normalized text (trim + case-insensitive) when IDs do not match', () => {
      const options = [opt(null, 'Alpha'), opt(undefined, 'Beta Option'), opt(null, 'Gamma')];
      const r = run({ options, saved: [{ optionId: 999, text: '  bEtA oPtIoN ' }] });
      expect(r.selected()).toEqual([false, true, false]);
      expect(r.patchValue).toHaveBeenCalledWith({ selectedOptionId: 1 }, { emitEvent: false });
    });

    it('matches by ID given as a string or number', () => {
      const r = run({ options: abc(), saved: [{ optionId: '3' }] });
      expect(r.selected()).toEqual([false, false, true]);
    });

    it('selects every matching option but records ONLY the first matching index', () => {
      // option 0 matches by ID, option 2 matches by text.
      const options = [opt(5, 'First'), opt(6, 'Second'), opt(7, 'Third')];
      const r = run({ options, saved: [{ optionId: 5, text: 'third' }] });
      expect(r.selected()).toEqual([true, false, true]);
      expect(r.patchValue).toHaveBeenCalledTimes(1);
      expect(r.patchValue).toHaveBeenCalledWith({ selectedOptionId: 0 }, { emitEvent: false });
    });

    it('records the first match even when an earlier option does not match', () => {
      const options = [opt(1, 'a'), opt(2, 'b'), opt(3, 'c'), opt(4, 'd')];
      const r = run({ options, saved: [{ optionId: 3 }, { optionId: 4 }] });
      expect(r.selected()).toEqual([false, false, true, true]);
      expect(r.patchValue).toHaveBeenCalledWith({ selectedOptionId: 2 }, { emitEvent: false });
    });

    it('clears a stale selected flag on options that do not match', () => {
      const options = abc();
      options[0].selected = true;
      const r = run({ options, saved: [{ optionId: 3 }] });
      expect(r.selected()).toEqual([false, false, true]);
    });

    it('no matching saved selection: nothing selected and the radio group is untouched', () => {
      const r = run({ options: abc(), saved: [{ optionId: 99, text: 'Nothing' }] });
      expect(r.selected()).toEqual([false, false, false]);
      expect(r.patchValue).not.toHaveBeenCalled();
    });

    it('does not patch when there is no form', () => {
      const r = run({ options: abc(), saved: [{ optionId: 1 }], withForm: false });
      expect(r.selected()).toEqual([true, false, false]);
      expect(r.patchValue).not.toHaveBeenCalled();
    });

    it('rebuilds bindings from the saved selections (isMulti = false)', () => {
      const saved = [{ optionId: 1 }];
      const r = run({ options: abc(), saved });
      expect(r.hydrate).toHaveBeenCalledWith(['existing'], saved, false);
      expect(r.setBindings).toHaveBeenCalledWith(['hydrated']);
    });
  });

  describe('multi-answer', () => {
    it('resets every option to unselected, even ones that match a saved selection', () => {
      const options = abc();
      options.forEach((o) => (o.selected = true));
      const r = run({
        options,
        type: 'multiple',
        saved: [{ optionId: 1 }, { optionId: 2, text: 'Beta' }]
      });
      expect(r.selected()).toEqual([false, false, false]);
    });

    it('never patches the radio group, but still rebuilds bindings (isMulti = true)', () => {
      const saved = [{ optionId: 1 }, { optionId: 3 }];
      const r = run({ options: abc(), type: 'multiple', saved });
      expect(r.patchValue).not.toHaveBeenCalled();
      expect(r.hydrate).toHaveBeenCalledWith(['existing'], saved, true);
      expect(r.setBindings).toHaveBeenCalledWith(['hydrated']);
    });
  });

  describe('guards', () => {
    it.each([
      ['no saved selections', { saved: [] as Saved[] }],
      ['saved selections are null', { saved: null }],
      ['no options', { saved: [{ optionId: 1 }], options: [] as Option[] }],
      ['question index is null', { saved: [{ optionId: 1 }], questionIndex: null }],
      ['question index is undefined', { saved: [{ optionId: 1 }], questionIndex: undefined }],
      ['question index is negative', { saved: [{ optionId: 1 }], questionIndex: -1 }]
    ] as [string, Partial<Parameters<typeof run>[0]>][])(
      'does nothing when %s',
      (_name, over) => {
        const options = over.options ?? abc();
        options.forEach((o) => (o.selected = true));
        const r = run({ options, ...over });
        // Untouched: flags keep their value, nothing hydrated, nothing patched.
        expect(options.every((o) => o.selected === true)).toBe(true);
        expect(r.hydrate).not.toHaveBeenCalled();
        expect(r.setBindings).not.toHaveBeenCalled();
        expect(r.patchValue).not.toHaveBeenCalled();
      }
    );

    it('asks the service for the saved selections of the CURRENT question', () => {
      const r = run({ options: abc(), saved: [{ optionId: 1 }], questionIndex: 4 });
      expect(r.fake.selectedOptionService.getSelectedOptionsForQuestion).toHaveBeenCalledWith(4);
    });
  });
});
