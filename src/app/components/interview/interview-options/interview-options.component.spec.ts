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

  function setup(questionType: InterviewQuestionType, selectedIds: number[] = [], disabled = false) {
    fixture = TestBed.createComponent(InterviewOptionsComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('options', options);
    fixture.componentRef.setInput('questionType', questionType);
    fixture.componentRef.setInput('selectedIds', selectedIds);
    fixture.componentRef.setInput('disabled', disabled);
    fixture.detectChanges();
  }

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [InterviewOptionsComponent] }).compileComponents();
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
