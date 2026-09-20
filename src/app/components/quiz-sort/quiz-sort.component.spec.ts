import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { MatTooltip } from '@angular/material/tooltip';

import { QuizSortComponent } from './quiz-sort.component';
import type { AlphaDirection, DifficultyDirection } from '../../shared/models/QuizSort.type';

/**
 * The sort control is two compact toggle buttons — `[ Difficulty ↑ ]` and
 * `[ A–Z ]` — replacing a "Sort by difficulty:" label, an ↑/↓ button pair and an
 * A–Z / Z–A dropdown. It is presentational: it shows the direction it is given
 * and emits the OPPOSITE one when activated; the parent owns the state.
 *
 * Wording is asserted as literals on purpose, so a copy change fails here.
 */
describe('QuizSortComponent', () => {
  let fixture: ComponentFixture<QuizSortComponent>;
  let difficultyEmits: DifficultyDirection[];
  let alphaEmits: AlphaDirection[];

  function render(difficulty: DifficultyDirection = 'asc', alpha: AlphaDirection = 'az'): void {
    TestBed.configureTestingModule({ providers: [provideNoopAnimations()] });
    fixture = TestBed.createComponent(QuizSortComponent);
    difficultyEmits = [];
    alphaEmits = [];
    fixture.componentInstance.difficultyDirectionChange.subscribe((d) => difficultyEmits.push(d));
    fixture.componentInstance.alphaDirectionChange.subscribe((a) => alphaEmits.push(a));
    fixture.componentRef.setInput('difficultyDirection', difficulty);
    fixture.componentRef.setInput('alphaDirection', alpha);
    fixture.detectChanges();
  }

  const root = (): HTMLElement => fixture.nativeElement;
  const difficultyBtn = (): HTMLButtonElement => root().querySelector('.sort-btn--difficulty')!;
  const alphaBtn = (): HTMLButtonElement => root().querySelector('.sort-btn--alpha')!;
  const text = (el: Element): string => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  const tooltipOf = (selector: string): string =>
    fixture.debugElement.query(By.css(selector)).injector.get(MatTooltip).message;
  const DIFFICULTY = '.sort-btn--difficulty';
  const ALPHA = '.sort-btn--alpha';

  afterEach(() => fixture?.destroy());

  describe('structure — the simplified UI', () => {
    beforeEach(() => render());

    it('is exactly two native buttons: Difficulty and the alphabetical toggle', () => {
      const buttons = Array.from(root().querySelectorAll('button'));
      expect(buttons).toHaveLength(2);
      expect(buttons.every((b) => b.getAttribute('type') === 'button')).toBe(true);
      // Visible text per button (the icon is a separate, decorative element; the
      // gap between word and arrow is CSS `gap`, not a space character).
      expect(buttons.map((b) => b.querySelector('.sort-btn__text')?.textContent?.trim())).toEqual(['Difficulty', 'A–Z']);
      expect(buttons[0].querySelectorAll('mat-icon')).toHaveLength(1);
      expect(buttons[1].querySelectorAll('mat-icon')).toHaveLength(0);
    });

    it('no longer renders the "Sort by difficulty:" label, the ↑/↓ button pair, or the A–Z dropdown', () => {
      expect(root().textContent).not.toContain('Sort by difficulty:');
      expect(root().querySelector('.sort-label')).toBeNull();
      expect(root().querySelector('select')).toBeNull();
      expect(root().querySelector('option')).toBeNull();
      // One difficulty control, not an ↑ and a ↓.
      expect(root().querySelectorAll('.sort-btn--difficulty')).toHaveLength(1);
    });
  });

  describe('Difficulty button', () => {
    it.each([
      ['asc', 'arrow_upward'],
      ['desc', 'arrow_downward']
    ] as const)('when %s it shows the word "Difficulty" plus the %s arrow, inside the SAME button', (direction, icon) => {
      render(direction);

      const btn = difficultyBtn();
      expect(btn.querySelector('.sort-btn__text')?.textContent?.trim()).toBe('Difficulty');
      expect(btn.querySelector('mat-icon')?.textContent?.trim()).toBe(icon);
    });

    it('toggles direction: asc → desc, and desc → asc', () => {
      render('asc');
      difficultyBtn().click();
      expect(difficultyEmits).toEqual(['desc']);

      fixture.componentRef.setInput('difficultyDirection', 'desc');
      fixture.detectChanges();
      difficultyBtn().click();
      expect(difficultyEmits).toEqual(['desc', 'asc']);
    });

    it('flips ONLY the difficulty dimension — the alphabetical direction is never emitted or reset', () => {
      render('asc', 'za');
      difficultyBtn().click();

      expect(difficultyEmits).toEqual(['desc']);
      expect(alphaEmits).toEqual([]);
    });
  });

  describe('alphabetical button', () => {
    it.each([
      ['az', 'A–Z'],
      ['za', 'Z–A']
    ] as const)('when %s it reads "%s"', (direction, label) => {
      render('asc', direction);
      expect(text(alphaBtn())).toBe(label);
    });

    it('keeps the existing toggle: A–Z → Z–A, and Z–A → A–Z', () => {
      render('asc', 'az');
      alphaBtn().click();
      expect(alphaEmits).toEqual(['za']);

      fixture.componentRef.setInput('alphaDirection', 'za');
      fixture.detectChanges();
      alphaBtn().click();
      expect(alphaEmits).toEqual(['za', 'az']);
    });

    it('flips ONLY the alphabetical dimension — the difficulty direction is never emitted or reset', () => {
      render('desc', 'az');
      alphaBtn().click();

      expect(alphaEmits).toEqual(['za']);
      expect(difficultyEmits).toEqual([]);
    });
  });

  describe('accessibility', () => {
    it.each([
      ['asc', 'Sort by difficulty ascending'],
      ['desc', 'Sort by difficulty descending']
    ] as const)('Difficulty (%s): accessible name is "%s"', (direction, name) => {
      render(direction);
      expect(difficultyBtn().getAttribute('aria-label')).toBe(name);
    });

    it.each([
      ['az', 'Sort alphabetically A to Z'],
      ['za', 'Sort alphabetically Z to A']
    ] as const)('Alphabetical (%s): accessible name is "%s"', (direction, name) => {
      render('asc', direction);
      expect(alphaBtn().getAttribute('aria-label')).toBe(name);
    });

    it('the accessible names follow the state as it changes — they are not fixed strings', () => {
      render('asc', 'az');
      fixture.componentRef.setInput('difficultyDirection', 'desc');
      fixture.componentRef.setInput('alphaDirection', 'za');
      fixture.detectChanges();

      expect(difficultyBtn().getAttribute('aria-label')).toBe('Sort by difficulty descending');
      expect(alphaBtn().getAttribute('aria-label')).toBe('Sort alphabetically Z to A');
    });

    it('the current state is conveyed in WORDS — the arrow icon is decorative and hidden from assistive tech', () => {
      render('desc');

      const icon = difficultyBtn().querySelector('mat-icon')!;
      expect(icon.getAttribute('aria-hidden')).toBe('true');
      // The visible word "Difficulty" is inside the accessible name (label-in-name).
      expect(difficultyBtn().getAttribute('aria-label')!.toLowerCase()).toContain('difficulty');
      expect(difficultyBtn().getAttribute('aria-label')).toContain('descending');
    });

    it('tooltips say what ACTIVATING the button does, and follow the state', () => {
      render('asc', 'az');
      expect(tooltipOf(DIFFICULTY)).toBe('Beginner to Advanced. Select to sort Advanced to Beginner.');
      expect(tooltipOf(ALPHA)).toBe('A to Z within each difficulty. Select to sort Z to A.');

      fixture.componentRef.setInput('difficultyDirection', 'desc');
      fixture.componentRef.setInput('alphaDirection', 'za');
      fixture.detectChanges();
      expect(tooltipOf(DIFFICULTY)).toBe('Advanced to Beginner. Select to sort Beginner to Advanced.');
      expect(tooltipOf(ALPHA)).toBe('Z to A within each difficulty. Select to sort A to Z.');
    });

    it('is keyboard-operable: native, focusable, in the tab order', () => {
      render();
      for (const btn of [difficultyBtn(), alphaBtn()]) {
        expect(btn.tagName).toBe('BUTTON');   // Enter / Space activate a native button
        expect(btn.tabIndex).toBeGreaterThanOrEqual(0);
        btn.focus();
        expect(document.activeElement).toBe(btn);
      }
    });

    it('never disables itself, so focus is KEPT after activating (the old ↑/↓ pair disabled the pressed button)', () => {
      render('asc', 'az');
      difficultyBtn().focus();
      difficultyBtn().click();

      // The parent re-renders with the new direction.
      fixture.componentRef.setInput('difficultyDirection', 'desc');
      fixture.detectChanges();

      expect(difficultyBtn().disabled).toBe(false);
      expect(alphaBtn().disabled).toBe(false);
      expect(document.activeElement).toBe(difficultyBtn());
    });
  });
});
