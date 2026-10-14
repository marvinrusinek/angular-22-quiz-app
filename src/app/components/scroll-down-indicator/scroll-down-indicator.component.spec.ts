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
