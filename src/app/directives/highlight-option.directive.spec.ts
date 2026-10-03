import { Component, input, ViewChild } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { Option, OptionBindings, SharedOptionConfig } from '@shared/models';

import { HighlightOptionDirective } from './highlight-option.directive';

/**
 * No prior coverage existed for this directive (no co-located spec, and
 * OptionItemComponent — its only real-world host — has no spec either), so
 * everything here is new. A dedicated minimal test host is used rather than
 * the real OptionItemComponent: that component injects eight services
 * (OptionService, QuestionResolutionService, QuizService,
 * TopicQuizTypeRegistry, QuestionVerdictService, SelectedOptionService,
 * TimerService, OptionItemTimerStateService, FeedbackPolicyService) that
 * have nothing to do with this directive's own behavior, and mocking all of
 * them would couple this spec to OptionItemComponent's internals instead of
 * the directive's actual contract (sharedOptionConfig in, DOM/option
 * mutations out).
 */

function makeOption(overrides: Partial<Option> = {}): Option {
  return {
    optionId: 1,
    text: 'Option A',
    correct: false,
    selected: false,
    active: true,
    highlight: false,
    showIcon: undefined,
    ...overrides
  };
}

function makeConfig(overrides: Partial<SharedOptionConfig> = {}): SharedOptionConfig {
  return {
    option: makeOption(),
    optionsToDisplay: [],
    selectedOption: null,
    currentQuestion: null,
    showFeedback: false,
    type: 'single',
    idx: 0,
    shouldResetBackground: false,
    correctMessage: '',
    showCorrectMessage: false,
    feedback: '',
    showFeedbackForOption: {},
    explanationText: '',
    showExplanation: false,
    isOptionSelected: false,
    selectedOptionIndex: null,
    isAnswerCorrect: false,
    highlightCorrectAfterIncorrect: false,
    ...overrides
  };
}

function makeBinding(option: Option, overrides: Partial<OptionBindings> = {}): OptionBindings {
  return {
    appHighlightOption: true,
    index: 0,
    option,
    isCorrect: null,
    feedback: '',
    showFeedback: false,
    showFeedbackForOption: {},
    highlightCorrectAfterIncorrect: false,
    highlightIncorrect: false,
    highlightCorrect: false,
    allOptions: [],
    type: 'single',
    appHighlightInputType: 'radio',
    appHighlightReset: false,
    appResetBackground: false,
    optionsToDisplay: [],
    isSelected: false,
    active: true,
    checked: false,
    change: () => {},
    disabled: false,
    ariaLabel: '',
    ...overrides
  };
}

// The host's own sharedOptionConfig/optionBinding are template-bound signal
// INPUTS (not plain class fields) specifically so updates go through
// `fixture.componentRef.setInput(...)` — confirmed, via an isolated minimal
// probe directive/component outside this spec, to be the only mechanism
// that reliably propagates a changed value down into a CHILD directive's own
// signal input in this Angular/Jest environment. A plain property mutation
// followed by fixture.detectChanges() (with or without
// autoDetectChanges/ApplicationRef.tick()/a microtask yield — all tried)
// left the bound template expression reading its ORIGINAL value even for a
// trivial unrelated probe directive and for plain `{{interpolation}}` with
// no directive involved at all, so this is an environment characteristic,
// not something particular to HighlightOptionDirective.
@Component({
  standalone: true,
  imports: [HighlightOptionDirective],
  template: `
    <div
      class="opt"
      appHighlightOption
      #dir="appHighlightOption"
      [sharedOptionConfig]="config()"
      [optionBinding]="binding()"
      (resetBackground)="resetBackgroundEvents.push($event)"
      (optionClicked)="optionClickedEvents.push($event)"
    >
      option content
    </div>
  `
})
class HostComponent {
  @ViewChild('dir') dirRef!: HighlightOptionDirective;
  readonly config = input.required<SharedOptionConfig>();
  readonly binding = input<OptionBindings>();
  resetBackgroundEvents: boolean[] = [];
  optionClickedEvents: Option[] = [];
}

describe('HighlightOptionDirective', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;
  let el: HTMLElement;

  function build(config: SharedOptionConfig, binding?: OptionBindings): void {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.componentRef.setInput('config', config);
    fixture.componentRef.setInput('binding', binding ?? makeBinding(config.option));
    el = fixture.nativeElement.querySelector('.opt') as HTMLElement;
  }

  /** Re-binds config/binding on an already-built fixture, via the one mechanism confirmed to propagate (see HostComponent's doc comment). */
  function update(config?: SharedOptionConfig, binding?: OptionBindings): void {
    if (config) fixture.componentRef.setInput('config', config);
    if (binding) fixture.componentRef.setInput('binding', binding);
  }

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  describe('1. initial config cleans up stale DOM state', () => {
    it('removes deactivated-option and restores cursor/pointer-events that were present before the first render', () => {
      build(makeConfig());
      // Pollute the host element BEFORE Angular runs any binding/effect —
      // the DOM node exists post-createComponent, pre-detectChanges.
      el.classList.add('deactivated-option');
      el.style.cursor = 'default';
      el.style.pointerEvents = 'none';

      fixture.detectChanges();
      TestBed.tick();

      expect(el.classList.contains('deactivated-option')).toBe(false);
      expect(el.style.cursor).toBe('pointer');
      expect(el.style.pointerEvents).toBe('auto');
    });
  });

  describe('2. showIcon: cleared when unselected, preserved when selected/highlighted', () => {
    it('clears an existing showIcon on an option the config says is NOT selected', () => {
      const option = makeOption({ showIcon: true, selected: false, highlight: false });
      const config = makeConfig({ option, isOptionSelected: false, shouldResetBackground: false });
      build(config);

      fixture.detectChanges();
      TestBed.tick();

      expect(option.showIcon).toBe(false);
    });

    // NOTE: cfg.isOptionSelected alone does NOT preserve showIcon via this
    // path — updateHighlightFromConfig()'s own isLiveSelected check only
    // reads binding?.isSelected / opt.selected / opt.highlight, never
    // cfg.isOptionSelected (that field is read by the SEPARATE legacy
    // updateHighlight() setTimeout path instead). The three tests below
    // cover each of the three signals this method actually checks.

    it('preserves an existing showIcon via option.selected', () => {
      const option = makeOption({ showIcon: true, selected: true, highlight: false });
      const config = makeConfig({ option, isOptionSelected: false, shouldResetBackground: false });
      build(config);

      fixture.detectChanges();
      TestBed.tick();

      expect(option.showIcon).toBe(true);
    });

    it('preserves an existing showIcon via option.highlight', () => {
      const option = makeOption({ showIcon: true, selected: false, highlight: true });
      const config = makeConfig({ option, isOptionSelected: false, shouldResetBackground: false });
      build(config);

      fixture.detectChanges();
      TestBed.tick();

      expect(option.showIcon).toBe(true);
    });

    it('preserves an existing showIcon via binding.isSelected (the live-binding path)', () => {
      const option = makeOption({ showIcon: true, selected: false, highlight: false });
      const config = makeConfig({ option, isOptionSelected: false, shouldResetBackground: false });
      const binding = makeBinding(option, { isSelected: true });
      build(config, binding);

      fixture.detectChanges();
      TestBed.tick();

      expect(option.showIcon).toBe(true);
    });
  });

  describe('3. shouldResetBackground overrides stale selected/highlighted state', () => {
    it('clears showIcon even when the option looks selected AND highlighted', () => {
      const option = makeOption({ showIcon: true, selected: true, highlight: true });
      const config = makeConfig({
        option,
        isOptionSelected: true,
        shouldResetBackground: true
      });
      const binding = makeBinding(option, { isSelected: true });
      build(config, binding);

      fixture.detectChanges();
      TestBed.tick();

      expect(option.showIcon).toBe(false);
    });
  });

  describe('4. the directive never forces showIcon=true', () => {
    it('leaves showIcon falsy on a selected option whose showIcon was never set to true by anything else', () => {
      const option = makeOption({ showIcon: undefined, selected: true, highlight: true });
      const config = makeConfig({ option, isOptionSelected: true, shouldResetBackground: false });
      const binding = makeBinding(option, { isSelected: true });
      build(config, binding);

      fixture.detectChanges();
      TestBed.tick();

      expect(option.showIcon).toBeFalsy();
    });

    it('leaves showIcon false on a freshly-constructed, unselected option (it was already false, not flipped)', () => {
      const option = makeOption({ showIcon: false, selected: false, highlight: false });
      const config = makeConfig({ option });
      build(config);

      fixture.detectChanges();
      TestBed.tick();

      expect(option.showIcon).toBe(false);
    });
  });

  describe('5. a selection change before the deferred callback fires is respected', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('does not clear a newly-selected option\'s icon when optionBinding schedules updateHighlight()\'s setTimeout', () => {
      const option = makeOption({ showIcon: false, selected: false, highlight: false });
      const config = makeConfig({ option, isOptionSelected: false });
      const binding = makeBinding(option, { isSelected: false });
      build(config, binding);

      fixture.detectChanges();
      TestBed.tick(); // the optionBinding effect schedules updateHighlight()'s setTimeout(…, 0) here

      // A click lands AFTER scheduling but BEFORE the timer fires — exactly
      // what OptionItemComponent.onChanged/onContentClick do synchronously.
      binding.isSelected = true;
      option.selected = true;
      option.showIcon = true;

      jest.advanceTimersByTime(0); // let the deferred callback run

      expect(option.showIcon).toBe(true);
      expect(binding.isSelected).toBe(true);
    });

    it('REGRESSION: a deferred callback scheduled before destruction must not mutate state after destruction', () => {
      // updateHighlight()'s setTimeout(…, 0) was not tied to DestroyRef/
      // takeUntilDestroyed and had no "am I destroyed" guard. `option`
      // objects routinely outlive one component instance (the same
      // reference flows through selectedOptionService/quizService state
      // across navigation — see shared-option-binding.service.ts's
      // `{ ...b.option }` spreads, which copy but do not isolate the nested
      // option from being the SAME object a later render re-wraps).
      // REPRODUCED without the fix: the stale timer fired after
      // fixture.destroy() and clobbered a value set afterward back to its
      // pre-destruction state. Fixed with a minimal `destroyed` flag
      // (set in ngOnDestroy) checked first inside the callback.
      const option = makeOption({ showIcon: true, selected: false, highlight: false });
      const config = makeConfig({ option, isOptionSelected: false });
      const binding = makeBinding(option, { isSelected: false });
      build(config, binding);

      fixture.detectChanges();
      TestBed.tick(); // schedules updateHighlight()'s setTimeout(…, 0)

      fixture.destroy();

      // Something else (a new component instance reusing this same option
      // object, e.g. on revisit) sets it true AFTER destruction, before the
      // stale timer fires.
      option.showIcon = true;

      jest.advanceTimersByTime(0);

      expect(option.showIcon).toBe(true); // must NOT have been clobbered back to false post-destruction
    });

    it('still clears showIcon via the deferred callback when nothing selected it in the interim', () => {
      const option = makeOption({ showIcon: true, selected: false, highlight: false });
      const config = makeConfig({ option, isOptionSelected: false });
      const binding = makeBinding(option, { isSelected: false });
      build(config, binding);

      fixture.detectChanges();
      TestBed.tick();
      jest.advanceTimersByTime(0);

      expect(option.showIcon).toBe(false);
    });
  });

  describe('6. optionBinding.directiveInstance registration', () => {
    it('is registered to this directive instance on initial render', () => {
      const config = makeConfig();
      build(config);

      fixture.detectChanges();
      TestBed.tick();

      expect(host.binding()?.directiveInstance).toBe(host.dirRef);
      expect(host.dirRef).toBeInstanceOf(HighlightOptionDirective);
    });

    it('is updated to the same directive instance when the binding object is replaced', () => {
      const config = makeConfig();
      build(config);
      fixture.detectChanges();
      TestBed.tick();
      const directiveInstance = host.dirRef;

      const newOption = makeOption({ optionId: 2, text: 'Option B' });
      const newBinding = makeBinding(newOption);
      update(makeConfig({ option: newOption }), newBinding);
      fixture.detectChanges();
      TestBed.tick();

      expect(directiveInstance.optionBinding()).toBe(newBinding);
      expect(newBinding.directiveInstance).toBe(directiveInstance);
    });
  });

  describe('7. the host click handler is a no-op', () => {
    it('does not change selection/icon state or emit resetBackground/optionClicked on click', () => {
      const option = makeOption({ showIcon: false, selected: false, highlight: false });
      const config = makeConfig({ option, isOptionSelected: false });
      const binding = makeBinding(option, { isSelected: false });
      build(config, binding);

      fixture.detectChanges();
      TestBed.tick();

      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      fixture.detectChanges();

      expect(binding.isSelected).toBe(false);
      expect(option.selected).toBe(false);
      expect(option.highlight).toBe(false);
      expect(option.showIcon).toBe(false);
      expect(host.resetBackgroundEvents).toEqual([]);
      expect(host.optionClickedEvents).toEqual([]);
    });
  });

  describe('8. config/binding updates remove stale DOM state', () => {
    it('clears a deactivated-option class and restored styles left over from a previous question when sharedOptionConfig is replaced', () => {
      build(makeConfig());
      fixture.detectChanges();
      TestBed.tick();

      // Simulate a prior render having left the element in a disabled-looking
      // state (e.g. a legacy-path pass, or manual test pollution standing in
      // for it), then move to a new question's config.
      el.classList.add('deactivated-option');
      el.style.cursor = 'default';
      el.style.pointerEvents = 'none';

      const nextOption = makeOption({ optionId: 3, text: 'Option C' });
      update(makeConfig({ option: nextOption }), makeBinding(nextOption));
      fixture.detectChanges();
      TestBed.tick();

      expect(el.classList.contains('deactivated-option')).toBe(false);
      expect(el.style.cursor).toBe('pointer');
      expect(el.style.pointerEvents).toBe('auto');
    });

    it('clears a deactivated-option class and restored styles when only optionBinding is replaced (sharedOptionConfig unchanged)', () => {
      const config = makeConfig();
      build(config);
      fixture.detectChanges();
      TestBed.tick();

      el.classList.add('deactivated-option');
      el.style.cursor = 'default';
      el.style.pointerEvents = 'none';

      update(undefined, makeBinding(config.option));
      fixture.detectChanges();
      TestBed.tick();

      expect(el.classList.contains('deactivated-option')).toBe(false);
      expect(el.style.cursor).toBe('pointer');
      expect(el.style.pointerEvents).toBe('auto');
    });
  });
});
