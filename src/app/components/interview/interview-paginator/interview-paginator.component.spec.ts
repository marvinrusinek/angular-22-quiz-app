import { ComponentFixture, TestBed } from '@angular/core/testing';

import { InterviewPaginatorComponent } from './interview-paginator.component';

describe('InterviewPaginatorComponent', () => {
  let fixture: ComponentFixture<InterviewPaginatorComponent>;
  let component: InterviewPaginatorComponent;

  function setup(
    total: number,
    current: number,
    answered: ReadonlySet<number> = new Set(),
    canNext = true,
    marked: ReadonlySet<number> = new Set()
  ) {
    fixture = TestBed.createComponent(InterviewPaginatorComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('total', total);
    fixture.componentRef.setInput('currentIndex', current);
    fixture.componentRef.setInput('answered', answered);
    fixture.componentRef.setInput('canNext', canNext);
    fixture.componentRef.setInput('marked', marked);
    fixture.detectChanges();
  }

  const pageButtons = () =>
    Array.from(fixture.nativeElement.querySelectorAll('.pg-page')) as HTMLButtonElement[];
  const pageNumbers = () => pageButtons().map((b) => Number(b.textContent!.trim()));

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [InterviewPaginatorComponent] }).compileComponents();
  });

  it('renders numeric page buttons on desktop', () => {
    setup(20, 7);
    expect(pageButtons().length).toBeGreaterThan(0);
  });

  it('always represents the current question', () => {
    setup(20, 7);
    const current = fixture.nativeElement.querySelector('.pg-page.current') as HTMLButtonElement;
    expect(current).toBeTruthy();
    expect(Number(current.textContent!.trim())).toBe(8);   // 0-based 7 → shown "8"
    expect(current.getAttribute('aria-current')).toBe('true');
  });

  it('shows the first and last question', () => {
    setup(20, 7);
    const nums = pageNumbers();
    expect(nums).toContain(1);
    expect(nums).toContain(20);
  });

  it('shows ellipses for omitted ranges', () => {
    setup(20, 7);
    const ellipses = fixture.nativeElement.querySelectorAll('.pg-ellipsis');
    expect(ellipses.length).toBe(2);   // 1 … 6 7 8 9 10 … 20
  });

  it('does not render ellipses when everything fits', () => {
    setup(5, 2);
    expect(fixture.nativeElement.querySelectorAll('.pg-ellipsis').length).toBe(0);
    expect(pageNumbers()).toEqual([1, 2, 3, 4, 5]);
  });

  it('emits the target index when a page is clicked', () => {
    setup(20, 7);
    const emitted: number[] = [];
    component.select.subscribe((i) => emitted.push(i));
    const last = pageButtons().find((b) => b.textContent!.trim() === '20')!;
    last.click();
    expect(emitted).toEqual([19]);   // "20" → 0-based 19
  });

  it('ellipses are not interactive (rendered as non-button list items)', () => {
    setup(30, 15);
    const ellipsis = fixture.nativeElement.querySelector('.pg-ellipsis') as HTMLElement;
    expect(ellipsis.tagName.toLowerCase()).toBe('li');
    expect(ellipsis.querySelector('button')).toBeNull();
    expect(ellipsis.getAttribute('aria-hidden')).toBe('true');
  });

  it('conveys answered state via a filled-background class + accessible label', () => {
    setup(10, 3, new Set([2]));   // current Q4; Q3 answered; window covers Q1–Q6 + Q10
    const q3 = pageButtons().find((b) => b.textContent!.trim() === '3')!;
    expect(q3.classList.contains('answered')).toBe(true);
    expect(q3.getAttribute('aria-label')).toBe('Go to question 3, answered');

    const q5 = pageButtons().find((b) => b.textContent!.trim() === '5')!;
    expect(q5.classList.contains('answered')).toBe(false);
    expect(q5.getAttribute('aria-label')).toBe('Go to question 5, not answered');
  });

  describe('marked for review', () => {
    it('conveys marked state via its own class + accessible label suffix', () => {
      setup(10, 3, new Set(), true, new Set([4]));   // Q5 marked, window covers Q1–Q6 + Q10
      const q5 = pageButtons().find((b) => b.textContent!.trim() === '5')!;
      expect(q5.classList.contains('marked')).toBe(true);
      expect(q5.getAttribute('aria-label')).toBe('Go to question 5, not answered, marked for review');

      const q3 = pageButtons().find((b) => b.textContent!.trim() === '3')!;
      expect(q3.classList.contains('marked')).toBe(false);
      expect(q3.getAttribute('aria-label')).toBe('Go to question 3, not answered');
    });

    it('combines with answered — a question can be both at once, neither class overwrites the other', () => {
      setup(10, 3, new Set([4]), true, new Set([4]));   // Q5 answered AND marked
      const q5 = pageButtons().find((b) => b.textContent!.trim() === '5')!;
      expect(q5.classList.contains('answered')).toBe(true);
      expect(q5.classList.contains('marked')).toBe(true);
      expect(q5.getAttribute('aria-label')).toBe('Go to question 5, answered, marked for review');
    });

    it('never exposes correctness via the marked state', () => {
      setup(10, 0, new Set(), true, new Set([1, 2]));
      for (const b of pageButtons()) {
        expect(b.className).not.toMatch(/correct|incorrect|wrong|right/i);
      }
    });

    it('defaults to an empty set so the component works standalone', () => {
      fixture = TestBed.createComponent(InterviewPaginatorComponent);
      component = fixture.componentInstance;
      fixture.componentRef.setInput('total', 10);
      fixture.componentRef.setInput('currentIndex', 0);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.pg-page.marked')).toBeNull();
    });
  });

  it('never exposes correctness on any page', () => {
    setup(10, 0, new Set([1, 2]));
    for (const b of pageButtons()) {
      expect(b.className).not.toMatch(/correct|incorrect|wrong|right/i);
      expect(b.getAttribute('aria-label')).not.toMatch(/correct|incorrect|wrong/i);
    }
  });

  it('HIDES Prev at the first question and HIDES Next at the last', () => {
    setup(20, 0);
    // Prev is hidden on Q1 (nothing to go back to), mirroring Next on the last.
    expect(fixture.nativeElement.querySelector('.pg-prev')).toBeNull();     // Prev hidden on first
    expect(fixture.nativeElement.querySelector('.pg-next')).toBeTruthy();   // Next shown

    setup(20, 19);
    expect(fixture.nativeElement.querySelector('.pg-prev')).toBeTruthy();   // Prev shown
    expect(fixture.nativeElement.querySelector('.pg-next')).toBeNull();     // Next hidden on last
  });

  // ── forward-navigation gate (canNext) ──────────────────────────────
  // canNext comes from InterviewSessionService#canNavigateNext, the SAME rule
  // the keyboard's ArrowRight uses — the button must never decide for itself.
  describe('Next gating', () => {
    const nextBtn = () => fixture.nativeElement.querySelector('.pg-next') as HTMLButtonElement | null;

    it('DISABLES Next when the current question is unanswered', () => {
      setup(10, 0, new Set(), /* canNext */ false);
      expect(nextBtn()).toBeTruthy();          // still visible, just not usable
      expect(nextBtn()!.disabled).toBe(true);
    });

    it('ENABLES Next once the current question is answered', () => {
      setup(10, 0, new Set([0]), /* canNext */ true);
      expect(nextBtn()!.disabled).toBe(false);
    });

    it('does not emit from goNext() while gated (no synthetic bypass)', () => {
      setup(10, 0, new Set(), false);
      const emitted: number[] = [];
      component.select.subscribe((i) => emitted.push(i));
      component.goNext();
      expect(emitted).toEqual([]);
    });

    it('emits from goNext() once ungated', () => {
      setup(10, 0, new Set([0]), true);
      const emitted: number[] = [];
      component.select.subscribe((i) => emitted.push(i));
      component.goNext();
      expect(emitted).toEqual([1]);
    });

    it('leaves PREVIOUS enabled even when Next is gated', () => {
      setup(10, 5, new Set(), false);
      const prev = fixture.nativeElement.querySelector('.pg-prev') as HTMLButtonElement;
      expect(prev).toBeTruthy();
      expect(prev.disabled).toBe(false);
    });

    it('leaves DIRECT numeric page jumps enabled when Next is gated', () => {
      // Users must still be able to skip ahead, review and come back.
      setup(10, 0, new Set(), false);
      const pages = pageButtons();
      expect(pages.length).toBeGreaterThan(0);
      expect(pages.every((b) => !b.disabled)).toBe(true);

      const emitted: number[] = [];
      component.select.subscribe((i) => emitted.push(i));
      pages.find((b) => b.textContent!.trim() === '10')!.click();
      expect(emitted).toEqual([9]);
    });

    it('defaults canNext to true so the component works standalone', () => {
      fixture = TestBed.createComponent(InterviewPaginatorComponent);
      component = fixture.componentInstance;
      fixture.componentRef.setInput('total', 10);
      fixture.componentRef.setInput('currentIndex', 0);
      fixture.detectChanges();
      expect((fixture.nativeElement.querySelector('.pg-next') as HTMLButtonElement).disabled).toBe(false);
    });
  });

  /**
   * `disabled` is the save gate: while an answer is being written to the
   * backend — or after a write failed — leaving the question would strand it.
   * Unlike `canNext`, this blocks EVERY direction, including Previous and
   * direct page jumps.
   */
  describe('disabled (save gate)', () => {
    function gated(current = 5) {
      setup(20, current, new Set([0, 1, 2, 3, 4, 5]), true);
      fixture.componentRef.setInput('disabled', true);
      fixture.detectChanges();
    }

    it('disables Previous, Next and every page button', () => {
      gated();
      expect((fixture.nativeElement.querySelector('.pg-prev') as HTMLButtonElement).disabled).toBe(true);
      expect((fixture.nativeElement.querySelector('.pg-next') as HTMLButtonElement).disabled).toBe(true);
      expect(pageButtons().every((b) => b.disabled)).toBe(true);
    });

    it('emits nothing from a page click, goNext(), goPrevious() or goTo()', () => {
      gated();
      const emitted: number[] = [];
      component.select.subscribe((i) => emitted.push(i));

      pageButtons()[0]!.click();
      component.goNext();
      component.goPrevious();
      component.goTo(9);

      expect(emitted).toEqual([]);
    });

    it('defaults to enabled so the component works standalone', () => {
      setup(20, 5, new Set([5]), true);
      expect(component.disabled()).toBe(false);
      expect((fixture.nativeElement.querySelector('.pg-next') as HTMLButtonElement).disabled).toBe(false);
    });

    it('re-enables every direction once the gate clears', () => {
      gated();
      fixture.componentRef.setInput('disabled', false);
      fixture.detectChanges();

      const emitted: number[] = [];
      component.select.subscribe((i) => emitted.push(i));
      component.goPrevious();
      component.goNext();

      expect(emitted).toEqual([4, 6]);
      expect(pageButtons().every((b) => !b.disabled)).toBe(true);
    });
  });

  it('renders the compact "Question X of Y" indicator for mobile', () => {
    setup(20, 7);
    const compact = fixture.nativeElement.querySelector('.pg-compact') as HTMLElement;
    expect(compact.textContent!.replace(/\s+/g, ' ').trim()).toBe('Question 8 of 20');
  });
});
