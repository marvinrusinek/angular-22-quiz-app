import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormBuilder } from '@angular/forms';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideRouter } from '@angular/router';

import { OptionItemComponent } from './option-item.component';

/**
 * Accessible-name structure of a single answer option.
 *
 * Material's radio/checkbox expose their label text as BOTH the native input's accessible name and
 * separate StaticText inside the <label>, so Narrator (scan mode) read every option twice. The fix
 * binds the name explicitly (`[aria-label]`, forwarded to the native input by Material) and hides the
 * visible label wrapper from assistive tech. These tests pin that structure for both control types.
 */
function mount(type: 'single' | 'multiple'): ComponentFixture<OptionItemComponent> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [OptionItemComponent], providers: [provideNoopAnimations(), provideRouter([])] });
  const fixture = TestBed.createComponent(OptionItemComponent);
  const option = { optionId: 11, questionIndex: 0, text: 'A design pattern where a class receives its dependencies', correct: true };
  fixture.componentRef.setInput('binding', { option, index: 0, isSelected: false } as never);
  fixture.componentRef.setInput('displayIndex', 0);
  fixture.componentRef.setInput('type', type);
  fixture.componentRef.setInput('form', new FormBuilder().group({ selectedOptionId: [null] }));
  fixture.componentRef.setInput('sharedOptionConfig', { type, option, optionsToDisplay: [option] } as never);
  fixture.detectChanges();
  return fixture;
}

describe.each([['single', 'input[type="radio"]'], ['multiple', 'input[type="checkbox"]']] as const)(
  'OptionItemComponent — %s option accessible name',
  (type, inputSelector) => {
    it('the NATIVE input carries the accessible name, equal to the visible option text', () => {
      const root: HTMLElement = mount(type).nativeElement;
      const input = root.querySelector(inputSelector)!;
      const visible = root.querySelector('.option-text')!.textContent!.trim();
      expect(input).not.toBeNull();
      expect(visible.length).toBeGreaterThan(0);
      expect(input.getAttribute('aria-label')).toBe(visible);
    });

    it('the visible label wrapper is hidden from assistive tech, so the text is exposed once', () => {
      const root: HTMLElement = mount(type).nativeElement;
      expect(root.querySelector('.option-wrapper')!.getAttribute('aria-hidden')).toBe('true');
      // the control itself, its label and the host stay exposed
      const input = root.querySelector(inputSelector)!;
      expect(input.closest('[aria-hidden="true"]')).toBeNull();
      expect(root.querySelector('label')!.getAttribute('aria-hidden')).toBeNull();
    });

    it('adds no extra focusable element: exactly one native input per option, and no tabindex overrides', () => {
      const root: HTMLElement = mount(type).nativeElement;
      expect(root.querySelectorAll('input')).toHaveLength(1);
      expect(root.querySelector('.option-wrapper')!.hasAttribute('tabindex')).toBe(false);
    });
  }
);
