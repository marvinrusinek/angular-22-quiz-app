import { ApplicationRef } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { AchievementsCatalogComponent, catalogRevealDelta } from './achievements-catalog.component';
import { AchievementView } from '@shared/models';

const VIEW: AchievementView[] = [
  {
    id: 'perfect-score',
    name: 'Perfect Score',
    description: 'Earn a 100% score on any quiz.',
    earned: true
  },
  {
    id: 'angular-explorer',
    name: 'Angular Explorer',
    description: 'Complete every available quiz.',
    earned: false
  },
  {
    id: 'beginner-complete',
    name: 'Beginner Complete',
    description: 'Complete every Beginner quiz.',
    earned: false
  }
];

describe('AchievementsCatalogComponent', () => {
  let fixture: ComponentFixture<AchievementsCatalogComponent>;
  let component: AchievementsCatalogComponent;

  let scrollBy: jest.Mock;

  beforeEach(() => {
    scrollBy = jest.fn();
    (window as any).scrollBy = scrollBy; // jsdom does not implement it
    TestBed.configureTestingModule({ imports: [AchievementsCatalogComponent] });
    fixture = TestBed.createComponent(AchievementsCatalogComponent);
    component = fixture.componentInstance;
  });

  /** aria-expanded is published two frames after the rows render (see expandedForAt). */
  afterEach(() => jest.restoreAllMocks());

  const settle = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 80));
    fixture.detectChanges();
  };
  const setAchievements = (list: AchievementView[]): void => {
    fixture.componentRef.setInput('achievements', list);
    fixture.detectChanges();
  };
  const toggleBtn = (): HTMLButtonElement | null =>
    fixture.nativeElement.querySelector('.achievements-catalog__toggle');
  const items = (): NodeListOf<HTMLElement> =>
    fixture.nativeElement.querySelectorAll('.achievements-catalog__item');

  it('renders nothing when the list is empty', () => {
    setAchievements([]);
    expect(fixture.nativeElement.querySelector('.achievements-catalog')).toBeNull();
  });

  it('shows the earned count in the collapsed header (X / N)', () => {
    setAchievements(VIEW);
    expect(toggleBtn()?.textContent?.replace(/\s+/g, ' ')).toContain('Achievements, 1 of 3');
  });

  it('is collapsed by default — the list is not rendered', () => {
    setAchievements(VIEW);
    expect(items().length).toBe(0);
    expect(toggleBtn()?.getAttribute('aria-expanded')).toBe('false');
  });

  it('expands on click to show ALL achievements', async () => {
    setAchievements(VIEW);
    toggleBtn()?.click();
    fixture.detectChanges();
    expect(items().length).toBe(3);
    await settle();
    expect(toggleBtn()?.getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps the description text and ends it with a non-breaking space before the status', () => {
    setAchievements(VIEW);
    toggleBtn()?.click();
    fixture.detectChanges();
    const desc = items()[0].querySelector('.achievements-catalog__desc')?.textContent ?? '';
    expect(desc).toBe('Earn a 100% score on any quiz.\u00a0');
    expect(items()[0].textContent).toContain('Earned');
  });

  it('distinguishes earned vs locked with state class + text (not color only)', () => {
    setAchievements(VIEW);
    toggleBtn()?.click();
    fixture.detectChanges();
    const rows = items();
    expect(rows[0].classList.contains('is-earned')).toBe(true);
    expect(rows[0].textContent).toContain('Earned');
    expect(rows[1].classList.contains('is-locked')).toBe(true);
    expect(rows[1].textContent).toContain('Locked');
  });

  it('toggles back to collapsed on a second click', () => {
    setAchievements(VIEW);
    toggleBtn()?.click();
    fixture.detectChanges();
    toggleBtn()?.click();
    fixture.detectChanges();
    expect(component.expanded()).toBe(false);
    expect(items().length).toBe(0);
  });

  it('each row is ONE named graphic: label "<name>. <description>. <Earned|Locked>."; duplicate visual children hidden; nothing interactive', () => {
    setAchievements(VIEW);
    toggleBtn()?.click();
    fixture.detectChanges();
    const ul = fixture.nativeElement.querySelector('ul') as HTMLElement;
    expect(ul.getAttribute('role')).toBe('none');
    expect(ul.querySelector('[aria-posinset],[aria-setsize]')).toBeNull();
    const rows = Array.from(items());
    expect(rows.length).toBe(3);
    expect(fixture.nativeElement.querySelectorAll('[role="img"]').length).toBe(3);
    expect(rows.map((li) => li.getAttribute('role'))).toEqual(['img', 'img', 'img']);
    expect(rows.map((li) => li.getAttribute('aria-label'))).toEqual([
      'Perfect Score. Earn a 100% score on any quiz. Earned.',
      'Angular Explorer. Complete every available quiz. Locked.',
      'Beginner Complete. Complete every Beginner quiz. Locked.'
    ]);
    rows.forEach((li) => {
      expect(li.hasAttribute('tabindex')).toBe(false);
      expect(
        li.querySelector(
          'a,button,input,select,textarea,summary,[tabindex],[role="img"],[role="button"],[aria-live]'
        )
      ).toBeNull();
      expect(li.querySelector('.achievements-catalog__body')?.getAttribute('aria-hidden')).toBe(
        'true'
      );
      expect(li.querySelector('.achievements-catalog__badge')?.getAttribute('aria-hidden')).toBe(
        'true'
      );
      expect(
        li.querySelector('.achievements-catalog__state-icon')?.getAttribute('aria-hidden')
      ).toBe('true');
    });
  });

  it('rowLabel drops only a terminal period', () => {
    expect(
      component.rowLabel({ ...VIEW[1], name: 'N', description: 'Ends with X', earned: false })
    ).toBe('N. Ends with X. Locked.');
    expect(
      component.rowLabel({ ...VIEW[1], name: 'N', description: 'Ends with dot.', earned: true })
    ).toBe('N. Ends with dot. Earned.');
  });

  it('keeps the visible row text (name, description, status) unchanged', () => {
    setAchievements(VIEW);
    toggleBtn()?.click();
    fixture.detectChanges();
    expect(items()[0].textContent).toContain('Perfect Score');
    expect(items()[0].textContent).toContain('Earn a 100% score on any quiz.');
    expect(items()[0].textContent).toContain('Earned');
    expect(items()[1].textContent).toContain('Locked');
  });

  it('names the toggle with ONE text node (no aria-label); visible title/count hidden from AT; chevron text never changes', () => {
    setAchievements(VIEW);
    const btn = toggleBtn() as HTMLButtonElement;
    const chevron = btn.querySelector('.achievements-catalog__chevron') as HTMLElement;
    const glyph = chevron.textContent?.trim();
    // No aria-label: a button named only by aria-label has no text of its own and Chrome's UIA range for it collapses to "A".
    expect(btn.hasAttribute('aria-label')).toBe(false);
    const nameNodes = Array.from(btn.children).filter((c) => c.getAttribute('aria-hidden') !== 'true');
    expect(nameNodes.length).toBe(1);
    expect(nameNodes[0].classList.contains('achievements-catalog__title')).toBe(true);
    expect(nameNodes[0].textContent?.trim()).toBe('Achievements, 1 of 3');
    expect(nameNodes[0].textContent).not.toMatch(/expanded|collapsed/i);
    // No aria-controls: it made Narrator repeat the toggle's name on the first Down Arrow into the list.
    expect(btn.hasAttribute('aria-controls')).toBe(false);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    Array.from(btn.children)
      .filter((c) => !c.classList.contains('achievements-catalog__title'))
      .forEach((c) => expect(c.getAttribute('aria-hidden')).toBe('true'));
    expect(btn.textContent).toContain('Achievements, 1 of 3');
    btn.click();
    fixture.detectChanges();
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(btn.querySelector('.achievements-catalog__title')?.textContent?.trim()).toBe('Achievements, 1 of 3');
    expect(chevron.classList.contains('is-open')).toBe(true);
    expect(chevron.textContent?.trim()).toBe(glyph);
    btn.click();
    fixture.detectChanges();
    expect(btn.getAttribute('aria-expanded')).toBe('false'); // close is immediate
    expect(chevron.classList.contains('is-open')).toBe(false);
  });

  describe('single expansion state and stale reveal cancellation', () => {
    const needsScroll = (): void => {
      jest.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: Element
      ) {
        // the toggle is near the bottom and the FIRST row ends below the viewport (768): a reveal scroll is needed
        if (this.id === 'achievements-catalog-list') return { top: 740, bottom: 1500 } as DOMRect;
        if (this.classList.contains('achievements-catalog__item')) return { top: 740, bottom: 800 } as DOMRect;
        return { top: 700, bottom: 740 } as DOMRect;
      });
    };
    const chevron = (): HTMLElement =>
      fixture.nativeElement.querySelector('.achievements-catalog__chevron');

    it('rows, aria-expanded and the chevron is-open class agree immediately, on open and on close', () => {
      setAchievements(VIEW);
      const state = () => ({
        rows: items().length > 0,
        aria: toggleBtn()?.getAttribute('aria-expanded'),
        open: chevron().classList.contains('is-open')
      });
      expect(state()).toEqual({ rows: false, aria: 'false', open: false });
      toggleBtn()?.click();
      fixture.detectChanges();
      expect(state()).toEqual({ rows: true, aria: 'true', open: true });
      toggleBtn()?.click();
      fixture.detectChanges();
      expect(state()).toEqual({ rows: false, aria: 'false', open: false });
    });

    it('one open scrolls exactly once', async () => {
      setAchievements(VIEW);
      needsScroll();
      toggleBtn()?.click();
      fixture.detectChanges();
      await settle();
      expect(scrollBy).toHaveBeenCalledTimes(1);
    });

    it('open then close before the render never scrolls', async () => {
      setAchievements(VIEW);
      needsScroll();
      toggleBtn()?.click();
      toggleBtn()?.click();
      fixture.detectChanges();
      await settle();
      expect(scrollBy).not.toHaveBeenCalled();
      expect(items().length).toBe(0);
    });

    it('open, close, reopen before the render scrolls once (only the latest open)', async () => {
      setAchievements(VIEW);
      needsScroll();
      toggleBtn()?.click();
      toggleBtn()?.click();
      toggleBtn()?.click();
      fixture.detectChanges();
      await settle();
      expect(scrollBy).toHaveBeenCalledTimes(1);
      expect(toggleBtn()?.getAttribute('aria-expanded')).toBe('true');
    });

    it('rapid repeated toggling ends consistent with at most one scroll', async () => {
      setAchievements(VIEW);
      needsScroll();
      for (let n = 0; n < 7; n++) toggleBtn()?.click();
      fixture.detectChanges();
      await settle();
      expect(scrollBy.mock.calls.length).toBeLessThanOrEqual(1);
      expect(toggleBtn()?.getAttribute('aria-expanded')).toBe('true');
      expect(items().length).toBe(3);
    });

    it('destroying the component before the render cancels the queued reveal', async () => {
      setAchievements(VIEW);
      needsScroll();
      toggleBtn()?.click();
      fixture.destroy();
      TestBed.inject(ApplicationRef).tick();
      await new Promise((r) => setTimeout(r, 40));
      expect(scrollBy).not.toHaveBeenCalled();
    });
  });

  describe('scroll on expansion', () => {
    it('scrolls once, immediately (behavior instant), only after the rows have rendered, and does not move focus', async () => {
      setAchievements(VIEW);
      const btn = toggleBtn() as HTMLButtonElement;
      btn.focus();
      const seenRows: number[] = [];
      scrollBy.mockImplementation(() => seenRows.push(items().length));
      // Toggle near the bottom of a 768px viewport; the rendered list extends far below it.
      jest
        .spyOn(btn, 'getBoundingClientRect')
        .mockReturnValue({ top: 700, bottom: 740 } as DOMRect);
      const realRect = Element.prototype.getBoundingClientRect;
      jest.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: Element
      ) {
        if (this.id === 'achievements-catalog-list') return { top: 740, bottom: 1500 } as DOMRect;
        // the FIRST row is what must stay in view: it ends 100px below the toggle's top
        if (this.classList.contains('achievements-catalog__item')) return { top: 740, bottom: 800 } as DOMRect;
        return realRect.call(this);
      });
      btn.click();
      fixture.detectChanges();
      await settle();
      const list = fixture.nativeElement.querySelector('#achievements-catalog-list') as HTMLElement;
      expect(list).not.toBeNull();
      expect(scrollBy).toHaveBeenCalledTimes(1);
      expect(scrollBy.mock.calls[0][0]).toEqual({ top: 800 - (768 - 12), left: 0, behavior: 'instant' });
      expect(seenRows).toEqual([3]); // rows existed when it scrolled
      expect(document.activeElement).toBe(btn);
    });

    it('does not scroll at all when the toggle and the first row are already in view, even if the list extends below the viewport', async () => {
      setAchievements(VIEW);
      const btn = toggleBtn() as HTMLButtonElement;
      jest.spyOn(btn, 'getBoundingClientRect').mockReturnValue({ top: 300, bottom: 345 } as DOMRect);
      const realRect = Element.prototype.getBoundingClientRect;
      jest.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: Element
      ) {
        if (this.id === 'achievements-catalog-list') return { top: 350, bottom: 1200 } as DOMRect;
        if (this.classList.contains('achievements-catalog__item')) return { top: 350, bottom: 405 } as DOMRect;
        return realRect.call(this);
      });
      btn.click();
      fixture.detectChanges();
      await settle();
      expect(scrollBy).not.toHaveBeenCalled();
    });

    it('does not scroll on close, or when the list merely stays open while inputs change', async () => {
      setAchievements(VIEW);
      toggleBtn()?.click();
      fixture.detectChanges();
      await fixture.whenStable();
      scrollBy.mockClear();
      setAchievements([...VIEW]);
      fixture.detectChanges();
      toggleBtn()?.click(); // close
      fixture.detectChanges();
      await fixture.whenStable();
      expect(scrollBy).not.toHaveBeenCalled();
    });
  });

  describe('catalogRevealDelta (viewport-relative geometry, 12px margin)', () => {
    it('is 0 when toggle and all rows are already visible', () => {
      expect(catalogRevealDelta(100, 500, 800)).toBe(0);
    });
    it('fits: scrolls down just enough to show the last row when only the bottom is cut off', () => {
      expect(catalogRevealDelta(300, 900, 800)).toBe(900 - (800 - 12));
    });
    it('fits: scrolls up just enough when the toggle is above the margin', () => {
      expect(catalogRevealDelta(-40, 300, 800)).toBe(-52);
    });
    it('does not fit: puts the toggle at the top margin (toggle + first row first), never the last row', () => {
      expect(catalogRevealDelta(600, 2100, 600)).toBe(600 - 12);
      expect(catalogRevealDelta(100, 100 + 2000, 600)).toBe(88);
    });
  });
});
