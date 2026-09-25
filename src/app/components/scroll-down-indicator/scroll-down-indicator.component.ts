import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  HostListener,
  OnInit,
  inject,
  signal
} from '@angular/core';

import { swallow } from '@shared/utils/error-logging';

/**
 * A subtle floating scroll cue pinned to the bottom-centre of the screen. Shown
 * only while the page is scrollable; it points DOWN when there is more content
 * below and flips to UP once the bottom is reached, so it doubles as a "back to
 * top" control.
 *
 * Mirrors the Interview Results scroll cue. Behaves like an elevator: each click
 * pages ~a screenful in the current direction. The direction flips at the
 * extremes (bottom → up, top → down) and PERSISTS in between, so repeated clicks
 * keep travelling the same way instead of reversing after one press.
 *  - real <button> (keyboard-activable), direction-aware aria-label + title
 *  - a gentle idle bounce nudges down until the user scrolls or clicks, then
 *    stops (also disabled under prefers-reduced-motion, in the SCSS)
 *  - native smooth scrolling only — no library
 */
@Component({
  selector: 'app-scroll-down-indicator',
  standalone: true,
  template: `
    @if (visible()) {
      <button
        type="button"
        class="scroll-indicator"
        [class.scroll-indicator--up]="direction() === 'up'"
        [class.scroll-indicator--bounce]="!hasInteracted()"
        (click)="onClick()"
        [attr.aria-label]="direction() === 'up' ? upAria : downAria"
        [attr.title]="direction() === 'up' ? upTitle : downTitle"
      >
        <i class="material-icons" aria-hidden="true">{{
          direction() === 'up' ? 'keyboard_arrow_up' : 'keyboard_arrow_down'
        }}</i>
      </button>
    }
  `,
  styleUrls: ['./scroll-down-indicator.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ScrollDownIndicatorComponent implements OnInit {
  // Shown only when the page can actually scroll.
  private readonly destroyRef = inject(DestroyRef);

  readonly visible = signal(false);
  // Travel direction. Flips at the extremes, persists in between.
  readonly direction = signal<'down' | 'up'>('down');
  // Idle bounce runs until the first user scroll or click.
  readonly hasInteracted = signal(false);

  // Bound via [attr.] (dynamic), so labels use $localize rather than template i18n.
  readonly downAria = $localize`Scroll down`;
  readonly upAria = $localize`Scroll back to top`;
  readonly downTitle = $localize`Scroll down`;
  readonly upTitle = $localize`Back to top`;

  private resizeObserver?: ResizeObserver;

  ngOnInit(): void {
    // Defer the first measure so fonts/images have laid out.
    setTimeout(() => this.recompute(), 300);

    // …but a single deferred measure is not enough. Pages like Interview Results
    // GROW after that first check as their async sections arrive (Performance
    // Trends, Readiness, Certificate status, Review Answers). If the page was
    // still short at 300ms the chevron hid and — with no scroll or resize to
    // react to — never came back, leaving a long page with no elevator control.
    // Watch the document for size changes so the cue appears as soon as the page
    // actually becomes scrollable.
    try {
      if (typeof ResizeObserver !== 'undefined') {
        this.resizeObserver = new ResizeObserver(() => this.recompute());
        this.resizeObserver.observe(document.documentElement);
      }
    } catch (err: unknown) {
      // Non-fatal: without the observer the indicator simply keeps its previous
      // scroll/resize-driven behaviour.
      swallow('scroll-down-indicator#resizeObserver', err);
    }
    this.destroyRef.onDestroy(() => this.resizeObserver?.disconnect());
  }

  // A genuine user scroll ends the idle bounce and updates direction.
  @HostListener('window:scroll')
  onWindowScroll(): void {
    if (!this.hasInteracted()) this.hasInteracted.set(true);
    this.recompute();
  }

  // Resize changes what's scrollable but is not a user "interaction".
  @HostListener('window:resize')
  onWindowResize(): void {
    this.recompute();
  }

  private recompute(): void {
    const doc = document.documentElement;
    const scrollable = doc.scrollHeight - window.innerHeight;
    this.visible.set(scrollable > 20);          // hide entirely on non-scrolling pages

    // 4px slack for sub-pixel rounding. Only the extremes change direction; in
    // between we keep the current one so repeated clicks travel the same way.
    if (window.scrollY >= scrollable - 4) this.direction.set('up');
    else if (window.scrollY <= 4) this.direction.set('down');
  }

  onClick(): void {
    this.hasInteracted.set(true);
    const step = Math.round(window.innerHeight * 0.85);
    const top = this.direction() === 'up' ? -step : step;
    window.scrollBy({ top, left: 0, behavior: 'smooth' });
  }
}
