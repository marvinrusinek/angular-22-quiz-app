import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ScrollDownIndicatorComponent } from './scroll-down-indicator.component';

/**
 * Elevator cue: points DOWN and pages down until the bottom (flips to UP), then
 * pages UP until the top (flips back to DOWN). Direction persists in between so
 * repeated clicks travel the same way. These tests drive the layout via mocked
 * window/document metrics so they're deterministic in jsdom.
 */
describe('ScrollDownIndicatorComponent', () => {
  let fixture: ComponentFixture<ScrollDownIndicatorComponent>;
  let component: ScrollDownIndicatorComponent;

  const setScroll = (scrollY: number, scrollHeight: number, innerHeight = 800) => {
    Object.defineProperty(window, 'innerHeight', { value: innerHeight, configurable: true });
    Object.defineProperty(window, 'scrollY', { value: scrollY, configurable: true });
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      value: scrollHeight,
      configurable: true
    });
  };

  const btn = () =>
    fixture.nativeElement.querySelector('.scroll-indicator') as HTMLButtonElement | null;
  const icon = () => btn()?.querySelector('i')?.textContent?.trim();

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ScrollDownIndicatorComponent]
    }).compileComponents();
    fixture = TestBed.createComponent(ScrollDownIndicatorComponent);
    component = fixture.componentInstance;
  });

  it('is hidden when the page does not scroll', () => {
    setScroll(0, 700, 800); // content shorter than viewport
    component.onWindowScroll();
    fixture.detectChanges();
    expect(btn()).toBeNull();
  });

  it('shows a real <button> with a down chevron when there is more below', () => {
    setScroll(0, 2000, 800);
    component.onWindowScroll();
    fixture.detectChanges();
    const b = btn();
    expect(b).toBeTruthy();
    expect(b!.tagName).toBe('BUTTON');
    expect(icon()).toBe('keyboard_arrow_down');
    expect(b!.getAttribute('aria-label')).toBe('Scroll down');
  });

  it('flips to an up chevron with a back-to-top label at the bottom', () => {
    setScroll(1200, 2000, 800); // scrollY (1200) === scrollHeight-innerHeight
    component.onWindowScroll();
    fixture.detectChanges();
    expect(icon()).toBe('keyboard_arrow_up');
    expect(btn()!.getAttribute('aria-label')).toBe('Scroll back to top');
    expect(btn()!.classList.contains('scroll-indicator--up')).toBe(true);
  });

  it('KEEPS the up direction while paging up in the middle (does not reverse)', () => {
    // Reach the bottom → up.
    setScroll(1200, 2000, 800);
    component.onWindowScroll();
    expect(component.direction()).toBe('up');

    // Now somewhere in the middle: neither top nor bottom → stays up.
    setScroll(600, 2000, 800);
    component.onWindowScroll();
    fixture.detectChanges();
    expect(component.direction()).toBe('up');
    expect(icon()).toBe('keyboard_arrow_up');

    // All the way back to the top → flips to down.
    setScroll(0, 2000, 800);
    component.onWindowScroll();
    fixture.detectChanges();
    expect(component.direction()).toBe('down');
    expect(icon()).toBe('keyboard_arrow_down');
  });

  it('runs the idle bounce until the user interacts, then stops', () => {
    setScroll(0, 2000, 800);
    // Simulate the deferred first measure without touching the "interacted" flag.
    (component as any).recompute();
    fixture.detectChanges();
    expect(btn()!.classList.contains('scroll-indicator--bounce')).toBe(true);

    component.onWindowScroll(); // a scroll counts as interaction
    fixture.detectChanges();
    expect(btn()!.classList.contains('scroll-indicator--bounce')).toBe(false);
  });

  it('resize updates layout WITHOUT counting as an interaction', () => {
    setScroll(0, 2000, 800);
    (component as any).recompute();
    fixture.detectChanges();
    component.onWindowResize();
    fixture.detectChanges();
    expect(component.hasInteracted()).toBe(false); // bounce still eligible
    expect(btn()!.classList.contains('scroll-indicator--bounce')).toBe(true);
  });

  it('click pages DOWN by a screenful when travelling down', () => {
    setScroll(0, 2000, 800);
    component.onWindowScroll();
    const spy = jest.spyOn(window, 'scrollBy').mockImplementation(() => {});
    component.onClick();
    expect(spy).toHaveBeenCalledTimes(1);
    const arg = spy.mock.calls[0][0] as any;
    expect(arg.behavior).toBe('smooth');
    expect(arg.top).toBeGreaterThan(0); // downward
    expect(arg.top).toBe(Math.round(800 * 0.85)); // ~a screenful
    spy.mockRestore();
  });

  it('click pages UP by a screenful when travelling up (symmetric)', () => {
    setScroll(1200, 2000, 800); // at the bottom → up
    component.onWindowScroll();
    const spy = jest.spyOn(window, 'scrollBy').mockImplementation(() => {});
    component.onClick();
    expect(spy).toHaveBeenCalledTimes(1);
    const arg = spy.mock.calls[0][0] as any;
    expect(arg.behavior).toBe('smooth');
    expect(arg.top).toBe(-Math.round(800 * 0.85)); // upward, same step
    spy.mockRestore();
  });
});

/**
 * Jump mode (Quiz Selection): chevron DOWN in the upper half of the page, UP in
 * the lower half; down jumps to the bottom, up jumps to the top. The default
 * elevator behaviour above is covered by the unchanged tests.
 */
describe('ScrollDownIndicatorComponent — jump mode', () => {
  let fixture: ComponentFixture<ScrollDownIndicatorComponent>;
  let component: ScrollDownIndicatorComponent;

  const setScroll = (scrollY: number, scrollHeight: number, innerHeight = 800) => {
    Object.defineProperty(window, 'innerHeight', { value: innerHeight, configurable: true });
    Object.defineProperty(window, 'scrollY', { value: scrollY, configurable: true });
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      value: scrollHeight,
      configurable: true
    });
  };
  const setReducedMotion = (reduce: boolean) => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: reduce && query.includes('prefers-reduced-motion'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {}
      })
    });
  };
  const btn = () =>
    fixture.nativeElement.querySelector('.scroll-indicator') as HTMLButtonElement | null;
  const icon = () => btn()?.querySelector('i')?.textContent?.trim();
  const at = (scrollY: number, scrollHeight = 2000, innerHeight = 800) => {
    setScroll(scrollY, scrollHeight, innerHeight);
    component.onWindowScroll();
    fixture.detectChanges();
  };

  beforeEach(async () => {
    setReducedMotion(false);
    await TestBed.configureTestingModule({
      imports: [ScrollDownIndicatorComponent]
    }).compileComponents();
    fixture = TestBed.createComponent(ScrollDownIndicatorComponent);
    fixture.componentRef.setInput('mode', 'jump');
    component = fixture.componentInstance;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('is hidden when the page does not scroll', () => {
    at(0, 700, 800);
    expect(btn()).toBeNull();
    at(0, 815, 800); // within the 20px slack
    expect(btn()).toBeNull();
  });

  it('shows a down chevron labelled "Scroll to bottom" at the top', () => {
    at(0);
    expect(btn()!.tagName).toBe('BUTTON');
    expect(icon()).toBe('keyboard_arrow_down');
    expect(btn()!.getAttribute('aria-label')).toBe('Scroll to bottom');
    expect(btn()!.getAttribute('title')).toBe('Scroll to bottom');
  });

  it('shows an up chevron labelled "Scroll back to top" at the bottom', () => {
    at(1200); // scrollable = 1200
    expect(icon()).toBe('keyboard_arrow_up');
    expect(btn()!.getAttribute('aria-label')).toBe('Scroll back to top');
    expect(btn()!.getAttribute('title')).toBe('Back to top');
  });

  it('switches direction at the halfway point of the scrollable range', () => {
    // scrollable = 2000 - 800 = 1200, halfway = 600
    at(599);
    expect(component.direction()).toBe('down');
    at(600);
    expect(component.direction()).toBe('up');
    at(601);
    expect(component.direction()).toBe('up');
    at(300);
    expect(component.direction()).toBe('down'); // follows position, not history
    at(900);
    expect(component.direction()).toBe('up');
  });

  it('chevron DOWN jumps straight to the bottom', () => {
    at(0);
    const spy = jest.spyOn(window, 'scrollTo').mockImplementation(() => {});
    component.onClick();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toEqual({ top: 1200, left: 0, behavior: 'smooth' });
  });

  it('chevron UP jumps straight to the top', () => {
    at(1100);
    const spy = jest.spyOn(window, 'scrollTo').mockImplementation(() => {});
    component.onClick();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toEqual({ top: 0, left: 0, behavior: 'smooth' });
  });

  it('never pages by a screenful (no scrollBy) in jump mode', () => {
    at(300);
    const by = jest.spyOn(window, 'scrollBy').mockImplementation(() => {});
    jest.spyOn(window, 'scrollTo').mockImplementation(() => {});
    component.onClick();
    expect(by).not.toHaveBeenCalled();
  });

  it('respects prefers-reduced-motion: jumps instantly, not smoothly', () => {
    setReducedMotion(true);
    at(0);
    const spy = jest.spyOn(window, 'scrollTo').mockImplementation(() => {});
    component.onClick();
    expect(spy.mock.calls[0][0]).toEqual({ top: 1200, left: 0, behavior: 'auto' });
    at(1100);
    component.onClick();
    expect(spy.mock.calls[1][0]).toEqual({ top: 0, left: 0, behavior: 'auto' });
  });

  it('is a native, keyboard-operable button with no live region', () => {
    at(0);
    const b = btn()!;
    expect(b.getAttribute('type')).toBe('button');
    expect(b.hasAttribute('tabindex')).toBe(false); // natively focusable
    expect(b.getAttribute('role')).toBeNull();
    expect(b.getAttribute('aria-live')).toBeNull();
    expect(fixture.nativeElement.querySelector('[aria-live], [role="status"]')).toBeNull();
    const spy = jest.spyOn(window, 'scrollTo').mockImplementation(() => {});
    b.click(); // what Enter / Space dispatch on a native button
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('keeps the idle bounce until the first scroll, like the elevator', () => {
    setScroll(0, 2000, 800);
    component.onWindowResize();
    fixture.detectChanges();
    expect(btn()!.classList.contains('scroll-indicator--bounce')).toBe(true);
    component.onWindowScroll();
    fixture.detectChanges();
    expect(btn()!.classList.contains('scroll-indicator--bounce')).toBe(false);
  });
});

describe('ScrollDownIndicatorComponent — default mode is unchanged', () => {
  it('defaults to the elevator and keeps its "Scroll down" label', async () => {
    await TestBed.configureTestingModule({
      imports: [ScrollDownIndicatorComponent]
    }).compileComponents();
    const fixture = TestBed.createComponent(ScrollDownIndicatorComponent);
    const component = fixture.componentInstance;
    expect(component.mode()).toBe('elevator');
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      value: 2000,
      configurable: true
    });
    component.onWindowScroll();
    fixture.detectChanges();
    const b = fixture.nativeElement.querySelector('.scroll-indicator') as HTMLElement;
    expect(b.getAttribute('aria-label')).toBe('Scroll down');
    const by = jest.spyOn(window, 'scrollBy').mockImplementation(() => {});
    const to = jest.spyOn(window, 'scrollTo').mockImplementation(() => {});
    component.onClick();
    expect(by).toHaveBeenCalledTimes(1); // pages, does not jump
    expect(to).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });
});
