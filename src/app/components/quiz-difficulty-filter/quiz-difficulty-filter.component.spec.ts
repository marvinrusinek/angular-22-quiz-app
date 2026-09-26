import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { MatSelect } from '@angular/material/select';
import { MatTooltip } from '@angular/material/tooltip';

import { QuizDifficultyFilterComponent } from './quiz-difficulty-filter.component';
import type { DifficultyFilter } from '@shared/models';

/**
 * The difficulty FILTER is a compact Material select: "All Difficulties",
 * "Beginner", "Intermediate", "Advanced". It is presentational — it shows the
 * value it is given and emits the new one; the parent owns the state and does the
 * filtering. Keyboard and screen-reader behaviour come from MatSelect itself, so
 * these tests check that we kept it (name, value, open state, arrow keys, Escape)
 * rather than re-implementing it.
 *
 * Wording is asserted as literals on purpose, so a copy change fails here.
 */
describe('QuizDifficultyFilterComponent', () => {
  let fixture: ComponentFixture<QuizDifficultyFilterComponent>;
  let emitted: DifficultyFilter[];

  function render(value: DifficultyFilter = 'all'): void {
    TestBed.configureTestingModule({ providers: [provideNoopAnimations()] });
    fixture = TestBed.createComponent(QuizDifficultyFilterComponent);
    emitted = [];
    fixture.componentInstance.difficultyChange.subscribe((v) => emitted.push(v));
    fixture.componentRef.setInput('difficulty', value);
    fixture.detectChanges();
  }

  const host = (): HTMLElement => fixture.nativeElement.querySelector('mat-select')!;
  const trigger = (): HTMLElement => fixture.nativeElement.querySelector('.mat-mdc-select-trigger')!;
  const options = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('mat-option'));
  const text = (e: Element): string => (e.textContent ?? '').replace(/\s+/g, ' ').trim();
  const shown = (): string => text(fixture.nativeElement.querySelector('.mat-mdc-select-value')!);

  /** MatSelect reads keyCode, so send both. */
  function press(key: string, keyCode: number): void {
    host().dispatchEvent(new KeyboardEvent('keydown', { key, code: key, keyCode, bubbles: true, cancelable: true }));
    fixture.detectChanges();
  }
  const ARROW_DOWN = 40, ARROW_UP = 38, ENTER = 13, ESCAPE = 27;

  function open(): void {
    trigger().click();
    fixture.detectChanges();
  }

  afterEach(() => fixture?.destroy());

  describe('what the control shows', () => {
    it.each([
      ['all', 'All Difficulties'],
      ['beginner', 'Beginner'],
      ['intermediate', 'Intermediate'],
      ['advanced', 'Advanced']
    ] as const)('shows "%s" as the text "%s" — the selection is conveyed in words, not by colour', async (value, label) => {
      render(value);
      // MatSelect applies its initial selection in a microtask after content init.
      await fixture.whenStable();
      fixture.detectChanges();

      expect(shown()).toBe(label);
    });

    it('offers exactly the four options, in order', () => {
      render();
      open();

      expect(options().map(text)).toEqual(['All Difficulties', 'Beginner', 'Intermediate', 'Advanced']);
    });

    it('marks the current option as selected for assistive technology', () => {
      render('intermediate');
      open();

      expect(options().map((o) => [text(o), o.getAttribute('aria-selected')])).toEqual([
        ['All Difficulties', 'false'],
        ['Beginner', 'false'],
        ['Intermediate', 'true'],
        ['Advanced', 'false']
      ]);
    });
  });

  describe('accessibility (MatSelect semantics preserved)', () => {
    it('is a combobox with an accessible name', () => {
      render();

      expect(host().getAttribute('role')).toBe('combobox');
      expect(host().getAttribute('aria-label')).toBe('Filter quizzes by difficulty');
    });

    it('exposes its open / closed state', () => {
      render();
      expect(host().getAttribute('aria-expanded')).toBe('false');

      open();
      expect(host().getAttribute('aria-expanded')).toBe('true');
      expect(host().getAttribute('aria-haspopup')).toBe('listbox');
    });

    it('is in the tab order (focusable)', () => {
      render();

      expect(host().tabIndex).toBe(0);
      host().focus();
      expect(document.activeElement).toBe(host());
    });
  });

  describe('tooltip and visible value', () => {
    const TIP = 'Filter quizzes by difficulty';
    const tooltipMessage = (): string => fixture.debugElement.query(By.directive(MatTooltip)).injector.get(MatTooltip).message;

    it.each(['all', 'beginner', 'intermediate', 'advanced'] as const)(
      'the tooltip is "Filter quizzes by difficulty" when "%s" is selected — it never varies with the selection',
      (value) => {
        render(value);
        expect(tooltipMessage()).toBe(TIP);
      }
    );

    it('the tooltip does not change as the selection changes', () => {
      render('all');
      const seen: string[] = [tooltipMessage()];
      for (const next of ['beginner', 'intermediate', 'advanced', 'all'] as const) {
        fixture.componentRef.setInput('difficulty', next);
        fixture.detectChanges();
        seen.push(tooltipMessage());
      }
      expect(new Set(seen)).toEqual(new Set([TIP]));
    });

    it('the accessible name is the same fixed text, so Material does not announce it twice', () => {
      render('beginner');
      expect(host().getAttribute('aria-label')).toBe(TIP);
      expect(host().getAttribute('aria-describedby') ?? '').not.toContain('cdk-describedby');
    });

    it('the tooltip steps aside while the option list is open (it must not linger behind the list), and returns afterwards', () => {
      render('all');
      const tooltip = (): MatTooltip => fixture.debugElement.query(By.directive(MatTooltip)).injector.get(MatTooltip);
      expect(tooltip().disabled).toBe(false);

      open();
      expect(tooltip().disabled).toBe(true);

      press('Escape', ESCAPE);
      expect(tooltip().disabled).toBe(false);
    });

    it('the option list is sized to its content, so "All Difficulties" is not squeezed onto two lines by the selection tick', () => {
      render('all');
      const select = fixture.debugElement.query(By.directive(MatSelect)).injector.get(MatSelect);

      expect(select.panelWidth).toBeNull();
    });

    it('what is DISPLAYED is the current filter, never the tooltip text or a "Quiz Difficulties" placeholder', async () => {
      render();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(shown()).toBe('All Difficulties');
      expect(shown()).not.toBe(TIP);
      expect(fixture.nativeElement.textContent).not.toContain('Quiz Difficulties');
      // No placeholder is set at all — a value is always selected.
      expect(fixture.nativeElement.querySelector('.mat-mdc-select-placeholder')).toBeNull();
    });
  });

  describe('choosing a difficulty', () => {
    it.each([
      ['Beginner', 'beginner'],
      ['Intermediate', 'intermediate'],
      ['Advanced', 'advanced'],
      ['All Difficulties', 'all']
    ] as const)('picking "%s" emits "%s" — and only that', (label, value) => {
      render(value === 'all' ? 'advanced' : 'all');   // start somewhere that makes the pick a change
      open();

      options().find((o) => text(o) === label)!.click();
      fixture.detectChanges();

      expect(emitted).toEqual([value]);
    });

    it('emits nothing until the user chooses (rendering and re-rendering are silent)', () => {
      render('beginner');
      fixture.componentRef.setInput('difficulty', 'advanced');
      fixture.detectChanges();

      expect(emitted).toEqual([]);
      expect(shown()).toBe('Advanced');
    });
  });

  describe('keyboard operation (provided by MatSelect)', () => {
    it('Arrow keys change the selection while closed', () => {
      render('all');
      host().focus();

      press('ArrowDown', ARROW_DOWN);
      expect(emitted).toEqual(['beginner']);
    });

    it('open with the keyboard, move with the arrows, choose with Enter', () => {
      render('all');
      host().focus();

      press('Enter', ENTER);                 // opens the list
      expect(host().getAttribute('aria-expanded')).toBe('true');
      press('ArrowDown', ARROW_DOWN);        // → Beginner
      press('ArrowDown', ARROW_DOWN);        // → Intermediate
      press('Enter', ENTER);                 // chooses it

      expect(emitted).toEqual(['intermediate']);
      expect(host().getAttribute('aria-expanded')).toBe('false');
    });

    it('Escape closes the list without changing anything, and focus stays on the control', () => {
      render('beginner');
      host().focus();
      press('Enter', ENTER);
      expect(host().getAttribute('aria-expanded')).toBe('true');

      press('Escape', ESCAPE);

      expect(host().getAttribute('aria-expanded')).toBe('false');
      expect(emitted).toEqual([]);
      expect(document.activeElement).toBe(host());
    });

    it('ArrowUp from the first option does not run off the list', () => {
      render('all');
      host().focus();

      press('ArrowUp', ARROW_UP);
      expect(emitted).toEqual([]);
    });
  });
});
