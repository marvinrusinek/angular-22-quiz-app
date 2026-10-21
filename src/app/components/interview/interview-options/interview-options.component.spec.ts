import { ComponentFixture, TestBed } from '@angular/core/testing';

import { InterviewOptionsComponent } from './interview-options.component';
import type {
  InterviewOptionViewModel,
  InterviewQuestionType
} from '@shared/models/interview/interview-view-models';

/**
 * Backend-migration regression suite.
 *
 * The active option model carries ONLY `optionId` and `text`, so multi-select
 * must come from the server `questionType`. This component previously derived
 * it from `correct === true`, which would render every backend question as a
 * radio group.
 */
describe('InterviewOptionsComponent', () => {
  let fixture: ComponentFixture<InterviewOptionsComponent>;
  let component: InterviewOptionsComponent;

  const options: InterviewOptionViewModel[] = [
    { optionId: 1, text: 'A' },
    { optionId: 2, text: 'B' },
    { optionId: 3, text: 'C' }
  ];

  function setup(
    questionType: InterviewQuestionType,
    selectedIds: number[] = [],
    disabled = false
  ) {
    fixture = TestBed.createComponent(InterviewOptionsComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('options', options);
    fixture.componentRef.setInput('questionType', questionType);
    fixture.componentRef.setInput('selectedIds', selectedIds);
    fixture.componentRef.setInput('disabled', disabled);
    fixture.detectChanges();
  }

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [InterviewOptionsComponent]
    }).compileComponents();
  });

  it('the active option model contains NO correctness', () => {
    for (const option of options) {
      expect(Object.keys(option).sort()).toEqual(['optionId', 'text']);
    }
  });

  it('renders radios for SINGLE', () => {
    setup('single');
    expect(component.isMultiSelect()).toBe(false);
    expect(fixture.nativeElement.querySelectorAll('input[type="radio"]').length).toBe(3);
  });

  it('renders checkboxes for MULTIPLE — from type, not correctness', () => {
    setup('multiple');
    expect(component.isMultiSelect()).toBe(true);
    expect(fixture.nativeElement.querySelectorAll('input[type="checkbox"]').length).toBe(3);
    expect(JSON.stringify(component.displayOptions())).not.toContain('correct');
  });

  it('renders TRUE/FALSE as single-select', () => {
    setup('trueFalse');
    expect(component.isMultiSelect()).toBe(false);
    expect(fixture.nativeElement.querySelectorAll('input[type="radio"]').length).toBe(3);
  });

  /**
   * CONFIRMED (code review, 2026-10-17): the option list's wrapper always
   * carried `role="group"`, even for radio (single-select) questions, where
   * the WAI-ARIA-correct role for a set of mutually-exclusive radio inputs
   * is `role="radiogroup"` — `role="group"` is for the checkbox (multiple)
   * case, where options are independent.
   */
  it('exposes role="radiogroup" for single/trueFalse, role="group" for multiple', () => {
    setup('single');
    expect(fixture.nativeElement.querySelector('.io-list')!.getAttribute('role')).toBe('radiogroup');

    setup('trueFalse');
    expect(fixture.nativeElement.querySelector('.io-list')!.getAttribute('role')).toBe('radiogroup');

    setup('multiple');
    expect(fixture.nativeElement.querySelector('.io-list')!.getAttribute('role')).toBe('group');
  });

  /**
   * Keyboard guidance for the single-answer radiogroup: visually hidden
   * (clip-based, NOT display:none/visibility:hidden/aria-hidden, so it
   * stays available to assistive technology), associated via
   * aria-describedby (read once on entering the group, never repeated by
   * a live region), and never applied to the multiple-answer checkbox
   * case, where Arrow-key navigation between options isn't the native
   * behavior.
   */
  describe('radiogroup keyboard guidance', () => {
    const HINT_TEXT = 'Use arrow keys to move between answers. Press Tab to leave the answer options.';

    it('associates the hint with the radiogroup via aria-describedby, for SINGLE', () => {
      setup('single');
      const list = fixture.nativeElement.querySelector('.io-list') as HTMLElement;
      const describedById = list.getAttribute('aria-describedby');
      expect(describedById).toBeTruthy();

      const hintEl = fixture.nativeElement.querySelector(`#${describedById}`) as HTMLElement;
      expect(hintEl).not.toBeNull();
      expect(hintEl.textContent!.trim()).toBe(HINT_TEXT);
    });

    it('associates the hint for TRUE/FALSE too (also single-select)', () => {
      setup('trueFalse');
      const list = fixture.nativeElement.querySelector('.io-list') as HTMLElement;
      expect(list.getAttribute('aria-describedby')).toBeTruthy();
    });

    it('is visually hidden via the clip technique, never display:none/visibility:hidden/aria-hidden', () => {
      setup('single');
      const list = fixture.nativeElement.querySelector('.io-list') as HTMLElement;
      const hintEl = fixture.nativeElement.querySelector(
        `#${list.getAttribute('aria-describedby')}`
      ) as HTMLElement;

      expect(hintEl.classList.contains('visually-hidden')).toBe(true);
      expect(hintEl.getAttribute('aria-hidden')).toBeNull();
      expect(hintEl.style.display).not.toBe('none');
      expect(hintEl.style.visibility).not.toBe('hidden');
    });

    it('does NOT apply the radio hint to the multiple-answer checkbox group', () => {
      setup('multiple');
      const list = fixture.nativeElement.querySelector('.io-list') as HTMLElement;
      expect(list.getAttribute('aria-describedby')).toBeNull();
      expect(fixture.nativeElement.textContent).not.toContain(HINT_TEXT);
    });

    it('uses a unique hint id per component instance', () => {
      const first = TestBed.createComponent(InterviewOptionsComponent);
      first.componentRef.setInput('options', options);
      first.componentRef.setInput('questionType', 'single');
      first.detectChanges();

      const second = TestBed.createComponent(InterviewOptionsComponent);
      second.componentRef.setInput('options', options);
      second.componentRef.setInput('questionType', 'single');
      second.detectChanges();

      const idFirst = first.nativeElement.querySelector('.io-list').getAttribute('aria-describedby');
      const idSecond = second.nativeElement.querySelector('.io-list').getAttribute('aria-describedby');
      expect(idFirst).not.toBe(idSecond);
    });
  });

  /**
   * CONFIRMED via real CDP accessibility-tree inspection (2026-10-17, not
   * assumed): a native <label> wrapping an <input> computes the input's
   * accessible name correctly from the label's text ("labelwrapped"
   * source), but the visible <span> that text came from is NOT pruned
   * from the tree — it remained a separate, non-ignored StaticText node
   * (same text, sibling to the radio/checkbox), which is what Narrator
   * was reading a second time while arrowing between options. Verified
   * fix (also via CDP): an explicit aria-label on the input + aria-hidden
   * on the span removes exactly that duplicate node (`ignored: true`,
   * reason `ariaHiddenSubtree`) while the exact same text is still what
   * gets announced, now sourced once.
   */
  describe('one accessible name per option (no duplicate announcement)', () => {
    it('each radio input has its own aria-label matching the option text, and its text span is aria-hidden', () => {
      setup('single');
      const labels = fixture.nativeElement.querySelectorAll('label.io-option');
      expect(labels.length).toBe(3);

      labels.forEach((label: HTMLElement, i: number) => {
        const input = label.querySelector('input')!;
        const span = label.querySelector('.io-text')!;
        expect(input.getAttribute('aria-label')).toBe(options[i]!.text);
        expect(span.getAttribute('aria-hidden')).toBe('true');
        // The visible text itself is UNCHANGED — still real, present text,
        // not removed, just not independently exposed to the AX tree.
        expect(span.textContent!.trim()).toBe(options[i]!.text);
      });
    });

    it('also applies to the multiple-answer checkbox case — the duplication is structural, not radio-specific', () => {
      setup('multiple');
      const labels = fixture.nativeElement.querySelectorAll('label.io-option');
      labels.forEach((label: HTMLElement, i: number) => {
        const input = label.querySelector('input')!;
        const span = label.querySelector('.io-text')!;
        expect(input.getAttribute('aria-label')).toBe(options[i]!.text);
        expect(span.getAttribute('aria-hidden')).toBe('true');
      });
    });

    it('does not remove the option text from the DOM — still visible, still present', () => {
      setup('single');
      expect(fixture.nativeElement.textContent).toContain('A');
      expect(fixture.nativeElement.textContent).toContain('B');
      expect(fixture.nativeElement.textContent).toContain('C');
    });
  });

  it('shows the multi-select hint only for multiple', () => {
    setup('multiple');
    expect(fixture.nativeElement.textContent).toContain('Select all that apply');
    setup('single');
    expect(fixture.nativeElement.textContent).not.toContain('Select all that apply');
  });

  it('single selection replaces the prior choice', () => {
    setup('single', [2]);
    const emitted: number[][] = [];
    component.selectionChange.subscribe((ids) => emitted.push(ids));
    component.onToggle(options[0]!);
    expect(emitted).toEqual([[1]]);
  });

  it('re-selecting the same single option keeps it selected', () => {
    setup('single', [1]);
    const emitted: number[][] = [];
    component.selectionChange.subscribe((ids) => emitted.push(ids));
    component.onToggle(options[0]!);
    expect(emitted).toEqual([[1]]);
  });

  it('multiple adds, removes, clears and allows all options', () => {
    setup('multiple', [1]);
    const added: number[][] = [];
    component.selectionChange.subscribe((ids) => added.push(ids));
    component.onToggle(options[1]!);
    expect([...added[0]!].sort()).toEqual([1, 2]);

    setup('multiple', [1, 2]);
    const removed: number[][] = [];
    component.selectionChange.subscribe((ids) => removed.push(ids));
    component.onToggle(options[0]!);
    expect(removed[0]).toEqual([2]);

    setup('multiple', [3]);
    const cleared: number[][] = [];
    component.selectionChange.subscribe((ids) => cleared.push(ids));
    component.onToggle(options[2]!);
    expect(cleared[0]).toEqual([]);

    setup('multiple', [1, 2]);
    const all: number[][] = [];
    component.selectionChange.subscribe((ids) => all.push(ids));
    component.onToggle(options[2]!);
    expect([...all[0]!].sort()).toEqual([1, 2, 3]);
  });

  it('preserves the SERVER option order — no re-sort, no AOTA re-pin', () => {
    const serverOrder: InterviewOptionViewModel[] = [
      { optionId: 1, text: 'A' },
      { optionId: 2, text: 'B' },
      { optionId: 3, text: 'All of the above' }
    ];
    fixture = TestBed.createComponent(InterviewOptionsComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('options', serverOrder);
    fixture.componentRef.setInput('questionType', 'single');
    fixture.detectChanges();
    expect(component.displayOptions().map((o) => o.optionId)).toEqual([1, 2, 3]);
  });

  it('reflects selectedIds and renders no correctness classes', () => {
    setup('single', [3]);
    expect(component.isSelected(options[2]!)).toBe(true);
    expect(component.isSelected(options[0]!)).toBe(false);
    expect(fixture.nativeElement.innerHTML).not.toMatch(/correct-option|incorrect-option/);
  });

  it('disabled blocks output and disables every input', () => {
    setup('multiple', [], true);
    const emitted: number[][] = [];
    component.selectionChange.subscribe((ids) => emitted.push(ids));
    component.onToggle(options[0]!);
    expect(emitted).toEqual([]);

    const inputs = [...fixture.nativeElement.querySelectorAll('input')] as HTMLInputElement[];
    expect(inputs.every((input) => input.disabled)).toBe(true);
  });
});
