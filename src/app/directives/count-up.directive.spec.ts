import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { CountUpDirective } from './count-up.directive';

@Component({
  standalone: true,
  imports: [CountUpDirective],
  template: `
    <span
      class="n"
      [appCountUp]="value"
      [countUpDelay]="0"
    ></span>
  `
})
class HostComponent {
  value = 20;
}

/**
 * Regression guard for the "negative number before counting up" bug.
 *
 * The old code anchored `start` to performance.now() taken just before the first
 * requestAnimationFrame. The frame timestamp handed to rAF can PREDATE that, so
 * the first frame's progress went slightly negative → easeOutCubic(<0) < 0 → a
 * one-frame negative value. The directive now anchors `start` to the first rAF
 * timestamp and clamps progress to [0, 1], so the text is always 0…target.
 */
describe('CountUpDirective', () => {
  let rafCallbacks: FrameRequestCallback[];
  let realRaf: typeof window.requestAnimationFrame;
  const tick = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    rafCallbacks = [];
    realRaf = window.requestAnimationFrame;
    // Capture rAF callbacks so the test drives the frame timeline deterministically.
    (window as any).requestAnimationFrame = (cb: FrameRequestCallback): number => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    };
    window.matchMedia = jest.fn().mockReturnValue({ matches: false } as MediaQueryList);
  });

  afterEach(() => {
    window.requestAnimationFrame = realRaf;
    TestBed.resetTestingModule();
  });

  // Build, flush afterNextRender + the (delay 0) setTimeout, so the first rAF is
  // pending in rafCallbacks.
  async function build(value: number): Promise<HTMLElement> {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    const fixture: ComponentFixture<HostComponent> = TestBed.createComponent(HostComponent);
    fixture.componentInstance.value = value;
    fixture.detectChanges();
    await fixture.whenStable(); // runs afterNextRender → animate() → setTimeout
    await tick(); // fire the delay-0 setTimeout → requests first frame
    return fixture.nativeElement.querySelector('.n') as HTMLElement;
  }

  /** Deliver a frame timestamp to the pending rAF tick, like the browser would. */
  const frame = (ts: number) => rafCallbacks.shift()?.(ts);

  it('never renders a negative number across the whole animation', async () => {
    const span = await build(20);
    const seen: number[] = [Number(span.textContent)];

    // The first timestamp (1000) is the anchor. Advance to completion; capture
    // every rendered value.
    for (const ts of [1000, 1200, 1400, 1600, 1800]) {
      frame(ts);
      seen.push(Number(span.textContent));
    }

    expect(seen.every((n) => Number.isFinite(n) && n >= 0)).toBe(true);
  });

  it('clamps an early/decreasing frame timestamp to 0 instead of going negative', async () => {
    const span = await build(50);
    frame(5000); // anchor
    frame(4990); // pathological earlier timestamp
    expect(Number(span.textContent)).toBeGreaterThanOrEqual(0);
  });

  it('lands exactly on the target value and pops', async () => {
    const span = await build(185);
    frame(2000); // anchor → progress 0
    frame(2000 + 800); // full 800ms duration → progress 1
    expect(span.textContent).toBe('185');
    expect(span.classList.contains('count-up-pop')).toBe(true);
  });

  it('sets a non-positive target immediately with no animation', async () => {
    const span = await build(0);
    expect(span.textContent).toBe('0');
    expect(rafCallbacks.length).toBe(0);
  });
});
