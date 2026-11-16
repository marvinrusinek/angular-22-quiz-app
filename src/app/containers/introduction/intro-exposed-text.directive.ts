import {
  afterNextRender,
  DestroyRef,
  Directive,
  effect,
  ElementRef,
  inject,
  Injector,
  input
} from '@angular/core';

/**
 * How the exposed text is laid out over the visible content.
 *  - `clone`: same typography and width as the visible text, so it wraps
 *    exactly like it (the subtitle).
 *  - `justify`: one line per visible row, fitted to the visible content box
 *    (the metadata rows with their icons).
 *  - `spread`: the width reference's own font and spacing, so the lines wrap
 *    like it, with the line-height spread so the lines span the visible
 *    content's height. For content that is much taller than its text (the
 *    feedback image above its sentence). No letter-spacing: a text range's
 *    rectangles ignore it, so Narrator would draw a far wider box.
 */
export type IntroExposedTextMode = 'clone' | 'justify' | 'spread';

/**
 * The ONE text item a Narrator scan-mode stop on a group exposes.
 *
 * Narrator's scan mode did not stop on a group whose children were all hidden,
 * and it read a group's children separately when they were exposed. So each
 * group hides its visible markup (`aria-hidden`, marked `data-intro-visible`)
 * and exposes exactly one transparent text node, laid out over the VISIBLE
 * content so its bounds (Narrator's highlight box) follow that content:
 * left/width from the longest visible line (icons included, or the element
 * marked data-intro-width-ref when there is one), height from the visible rows. The text is the same source as the visible text.
 *
 * Browsers fire no event when this text should be re-fitted, so it is
 * re-fitted when the text changes, when the group or the visible content is
 * resized, and when web fonts finish loading. The observer and the font
 * callback are released with the directive.
 */
@Directive({
  selector: '[appIntroExposedText]',
  standalone: true,
  host: {
    class: 'intro-exposed-text',
    // Self-contained (no component SCSS needed): transparent, never hit-tested,
    // never selectable. Its box is set by fit().
    style:
      'position:absolute;margin:0;padding:0;color:transparent;pointer-events:none;user-select:none;white-space:pre-line'
  }
})
export class IntroExposedTextDirective {
  readonly text = input.required<string>({ alias: 'appIntroExposedText' });
  readonly mode = input<IntroExposedTextMode>('clone', { alias: 'exposedTextMode' });
  /**
   * Narrator draws its box around the GROUP, not only the text, so a group
   * wider than its text gives an over-long box. When set, the group is sized
   * to the longest rendered line of the [data-intro-width-ref] element (or the
   * widest image, if wider): it wraps the same, as it is no narrower than that
   * line, and it is centred by its parent.
   */
  readonly fitGroupWidth = input(false, { alias: 'fitGroupWidth', transform: (v: unknown) => v === '' || v === true || v === 'true' });

  private readonly host: HTMLElement = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly injector = inject(Injector);
  private observer: ResizeObserver | null = null;
  private destroyed = false;

  constructor() {
    // One text node, set directly: interpolation splitting would add nodes.
    effect(() => {
      this.host.textContent = this.text();
      this.mode();
      afterNextRender(() => this.fit(), { injector: this.injector });
    });

    afterNextRender(() => {
      const group = this.host.parentElement;
      if (!group) return;
      if (typeof ResizeObserver !== 'undefined') {
        this.observer = new ResizeObserver(() => this.fit());
        // Sizing the group ourselves would re-trigger an observer on the group.
        this.observer.observe(this.fitGroupWidth() && group.parentElement ? group.parentElement : group);
        const visible = this.visible();
        if (visible) this.observer.observe(visible);
      }
      void document.fonts?.ready.then(() => {
        if (!this.destroyed) this.fit();
      });
    });

    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.observer?.disconnect();
      this.observer = null;
    });
  }

  private visible(): HTMLElement | null {
    return this.host.parentElement?.querySelector<HTMLElement>(':scope > [data-intro-visible]') ?? null;
  }

  /** Union of the visible text boxes and icons, in viewport coordinates. */
  private contentBox(visible: HTMLElement): { l: number; t: number; r: number; b: number } | null {
    const range = document.createRange();
    // jsdom (unit tests) has no layout: nothing to fit.
    if (typeof range.getClientRects !== 'function') return null;
    const rects: DOMRect[] = [];
    range.selectNodeContents(visible);
    rects.push(...Array.from(range.getClientRects()));
    visible.querySelectorAll('mat-icon, svg, img').forEach((i) => rects.push(i.getBoundingClientRect()));
    const real = rects.filter((r) => r.width > 0 && r.height > 0);
    if (!real.length) return null;
    const box = {
      l: Math.min(...real.map((r) => r.left)),
      t: Math.min(...real.map((r) => r.top)),
      r: Math.max(...real.map((r) => r.right)),
      b: Math.max(...real.map((r) => r.bottom))
    };
    // Optional horizontal reference: an element marked data-intro-width-ref
    // (the score sentence) sets the left/right edges from ITS longest rendered
    // line, so a wider neighbour (the feedback image) does not widen the box.
    // Vertical coverage still spans ALL of the visible content (image and text).
    const ref = visible.querySelector<HTMLElement>('[data-intro-width-ref]');
    if (ref) {
      const rr = document.createRange();
      rr.selectNodeContents(ref);
      const lines = Array.from(rr.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
      if (lines.length) {
        box.l = Math.min(...lines.map((r) => r.left));
        box.r = Math.max(...lines.map((r) => r.right));
      }
    }
    return box;
  }

  private textBox(): { top: number; width: number; height: number; ca: number } | null {
    const range = document.createRange();
    if (typeof range.getClientRects !== 'function') return null;
    range.selectNodeContents(this.host);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
    if (!rects.length) return null;
    return {
      top: Math.min(...rects.map((r) => r.top)),
      width: Math.max(...rects.map((r) => r.right)) - Math.min(...rects.map((r) => r.left)),
      height: Math.max(...rects.map((r) => r.bottom)) - Math.min(...rects.map((r) => r.top)),
      ca: rects[0].height
    };
  }

  /** Size the group to the width reference's longest line (see fitGroupWidth). */
  private fitGroup(group: HTMLElement, visible: HTMLElement): void {
    group.style.width = '';
    group.style.maxWidth = '100%';
    const ref = visible.querySelector<HTMLElement>('[data-intro-width-ref]');
    const range = document.createRange();
    if (!ref || typeof range.getClientRects !== 'function') return;
    range.selectNodeContents(ref);
    const lines = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
    if (!lines.length) return;
    const text = Math.max(...lines.map((r) => r.right)) - Math.min(...lines.map((r) => r.left));
    const widest = Math.max(text, ...Array.from(visible.querySelectorAll('img')).map((i) => i.getBoundingClientRect().width));
    // A quarter pixel of slack keeps the text from re-wrapping on rounding.
    group.style.width = `${widest + 0.25}px`;
  }

  private spread(
    box: { l: number; t: number; r: number; b: number },
    g: DOMRect,
    group: HTMLElement
  ): void {
    const style = this.host.style;
    const ref = group.querySelector<HTMLElement>('[data-intro-width-ref]');
    const cs = ref ? getComputedStyle(ref) : getComputedStyle(this.host);
    Object.assign(style, {
      whiteSpace: 'pre-line',
      textAlign: 'center',
      textAlignLast: 'auto',
      fontFamily: cs.fontFamily,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      letterSpacing: cs.letterSpacing,
      lineHeight: 'normal',
      top: '0px',
      // A quarter pixel of slack keeps the lines from re-wrapping on rounding.
      width: `${box.r - box.l + 0.25}px`
    });
    const probe = this.textBox();
    if (!probe) return;
    const lines = this.lineCount();
    const H = box.b - box.t;
    const lineHeight = lines > 1 ? (H - probe.ca) / (lines - 1) : H;
    style.lineHeight = `${lineHeight}px`;
    style.top = `${-(lineHeight - probe.ca) / 2}px`;
    const placed = this.textBox();
    if (placed) style.top = `${parseFloat(style.top) - (placed.top - g.top) + (box.t - g.top)}px`;
  }

  private lineCount(): number {
    const range = document.createRange();
    if (typeof range.getClientRects !== 'function') return 1;
    range.selectNodeContents(this.host);
    const tops = new Set(
      Array.from(range.getClientRects())
        .filter((r) => r.width > 0 && r.height > 0)
        .map((r) => Math.round(r.top))
    );
    return Math.max(1, tops.size);
  }

  private fit(): void {
    if (this.destroyed) return;
    const group = this.host.parentElement;
    const visible = this.visible();
    if (!group || !visible) return;
    if (this.fitGroupWidth()) this.fitGroup(group, visible);
    const box = this.contentBox(visible);
    if (!box) return;
    const g = group.getBoundingClientRect();
    const style = this.host.style;
    style.left = `${box.l - g.left}px`;
    style.width = `${box.r - box.l}px`;

    if (this.mode() === 'clone') {
      // Same typography and the visible wrapper's own top: identical line boxes.
      const v = visible.getBoundingClientRect();
      style.top = `${v.top - g.top}px`;
      for (const p of ['fontSize', 'letterSpacing', 'lineHeight', 'fontWeight', 'textAlign', 'textAlignLast']) {
        style.removeProperty(p.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));
      }
      style.whiteSpace = 'pre-line';
      // A fallback font can place the block's line box a pixel or two off the
      // inline text's; align the glyph boxes themselves with the visible ones.
      const placed = this.textBox();
      if (placed) style.top = `${parseFloat(style.top) + (box.t - placed.top)}px`;
      return;
    }

    if (this.mode() === 'spread') {
      this.spread(box, g, group);
      return;
    }

    // justify: fit one glyph row per visible row to the visible content box.
    const H = box.b - box.t;
    const W = box.r - box.l;
    const lines = this.text().split('\n');
    const longest = Math.max(...lines.map((l) => l.length));
    // Probe at 100px, unwrapped and unspaced: natural height and widest line.
    Object.assign(style, {
      whiteSpace: 'pre',
      textAlign: 'left',
      textAlignLast: 'auto',
      letterSpacing: '0px',
      lineHeight: 'normal',
      fontWeight: '700',
      fontSize: '100px',
      top: '0px'
    });
    const probe = this.textBox();
    if (!probe) return;
    const fontSize = (100 * H) / probe.height;
    const naturalWidth = (probe.width * fontSize) / 100;
    // Tighten letter-spacing only as much as needed to avoid wrapping; the
    // justified line then spreads back out to the full content width.
    const spacing = naturalWidth > W ? -((naturalWidth - W) / longest) - 1 : 0;
    Object.assign(style, {
      whiteSpace: 'pre-line',
      textAlign: 'justify',
      textAlignLast: 'justify',
      fontSize: `${fontSize}px`,
      letterSpacing: `${spacing}px`
    });
    const fitted = this.textBox();
    if (!fitted) return;
    // Size the glyph boxes to ~H/n, absorb the rest in line-height so the
    // union of the rows is exactly H; then correct the vertical offset.
    const rows = lines.length;
    const lineHeight = rows > 1 ? (H - fitted.ca) / (rows - 1) : H;
    style.lineHeight = `${lineHeight}px`;
    style.top = `${-(lineHeight - fitted.ca) / 2}px`;
    const placed = this.textBox();
    if (placed) {
      style.top = `${parseFloat(style.top) - (placed.top - g.top) + (box.t - g.top)}px`;
    }
  }
}
