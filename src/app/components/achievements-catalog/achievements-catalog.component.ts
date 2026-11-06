import {
  AfterRenderRef,
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  Injector,
  input,
  signal
} from '@angular/core';

import { AchievementView } from '@shared/models';

/**
 * Expandable "Achievements X / N" catalog for the Results screen.
 *
 * Collapsed it shows just the earned count. Clicking the header (a real button —
 * no hover-only behavior) reveals ALL achievements with each one's earned/locked
 * state clearly distinguished by icon + text label (not color alone).
 *
 * Pure presentation: it takes an already-resolved list of {definition, earned}
 * — no storage or rule logic. Renders nothing when the list is empty.
 *
 * Accessibility: a native disclosure button carrying `aria-expanded`, a labelled region,
 * and per-item "Earned"/"Locked" text so the state is conveyed without relying on color.
 * The button deliberately has NO `aria-controls`: with it, Narrator spoke the button's name again when
 * the first Down Arrow after expanding entered the list (the highlight was already on the first row).
 */
/** Breathing room kept above/below the revealed catalog, in px. */
const REVEAL_MARGIN = 12;

/**
 * How far to scroll (px, positive = down) so a just-opened catalog is usable.
 * All inputs are viewport-relative (getBoundingClientRect). `listBottom` is the bottom of the LAST row that
 * must be visible (the component passes the first row).
 *  - Toggle + that row fit: show them (minimal movement, 0 if already visible).
 *  - They do not fit: put the toggle at the top so it and the first row (and as many
 *    following rows as fit) are visible. Never aims at the last row.
 */
export function catalogRevealDelta(
  toggleTop: number,
  listBottom: number,
  viewportHeight: number,
  margin: number = REVEAL_MARGIN
): number {
  const fitsAll = listBottom - toggleTop <= viewportHeight - 2 * margin;
  if (!fitsAll) return toggleTop - margin;
  if (toggleTop < margin) return toggleTop - margin;
  if (listBottom > viewportHeight - margin) return listBottom - (viewportHeight - margin);
  return 0;
}

@Component({
  selector: 'codelab-achievements-catalog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (total() > 0) {
      <section class="achievements-catalog">
        <button
          type="button"
          class="achievements-catalog__toggle"
          [attr.aria-expanded]="expanded()"
          (click)="toggle()"
        >
          <span
            class="achievements-catalog__icon"
            aria-hidden="true"
          >
            🏆
          </span>
          <!-- The button's ONE accessible name comes from this single visible text span (toggleLabel(): "Achievements, N of M"),
               contributed by the native button's own name-from-contents: ordinary in-flow text, not hidden, no aria-label.
               Why not aria-label: a button whose name comes only from aria-label has no text of its own, and Chrome's
               UIA text range for it collapses to its first character ("A") as soon as a client clones it. The earlier invisible,
               button-sized (justified) label spread the words across the whole button, and Narrator read it in pieces on arrival
               ("button collapsed Achievements 6 of button collapsed 6"). Expanded/collapsed comes from aria-expanded. Nothing
               INSIDE the focused button changes text on toggle: the chevron is one fixed glyph rotated by CSS. -->
          <span class="achievements-catalog__title">{{ toggleLabel() }}</span>
          <span
            class="achievements-catalog__chevron"
            [class.is-open]="expanded()"
            aria-hidden="true"
          >
            ▼
          </span>
        </button>

        @if (expanded()) {
          <!-- role="none" on the <ul>: no list semantics, so no item positions ("2 of 6") are announced. Each row is
               ONE named graphic (role="img") whose name is "<name>. <description>. <Earned|Locked>."; its visible
               icon, name, description and status are hidden from assistive technology so nothing is read twice.
               Nothing interactive lives inside a row (no tabindex, focus handling or key handlers). -->
          <ul
            id="achievements-catalog-list"
            class="achievements-catalog__list"
            role="none"
          >
            @for (achievement of achievements(); track achievement.id) {
              <li
                role="img"
                [attr.aria-label]="rowLabel(achievement)"
                class="achievements-catalog__item"
                [class.is-earned]="achievement.earned"
                [class.is-locked]="!achievement.earned"
              >
                <span
                  class="achievements-catalog__state-icon"
                  aria-hidden="true"
                >
                  {{ achievement.earned ? '✓' : '🔒' }}
                </span>
                <span
                  class="achievements-catalog__body"
                  aria-hidden="true"
                >
                  <span class="achievements-catalog__name">
                    @if (achievement.icon) {
                      <span
                        class="achievements-catalog__emoji"
                        aria-hidden="true"
                      >
                        {{ achievement.icon }}
                      </span>
                    }
                    {{ achievement.name }}
                  </span>
                  <!-- Trailing U+00A0 (&nbsp;): a plain/collapsible space between this description and the
                       Earned/Locked status is dropped from the page's accessible text, so UIA exposed
                       "...quiz.LOCKED" (Narrator spoke a "dot" there). A non-breaking space survives. -->
                  <span class="achievements-catalog__desc">{{ achievement.description }}&nbsp;</span>
                </span>
                <span
                  class="achievements-catalog__badge"
                  aria-hidden="true"
                >
                  @if (achievement.earned) {
                    <ng-container i18n>Earned</ng-container>
                  } @else {
                    <ng-container i18n>Locked</ng-container>
                  }
                </span>
              </li>
            }
          </ul>
        }
      </section>
    }
  `,
  styles: [
    `
      .achievements-catalog {
        max-width: 640px;
        margin: 12px auto 8px;
        border: 1px solid var(--border-color, #e0e0e0);
        border-radius: 10px;
        background: var(--bg-secondary, #f5f5f5);
        box-sizing: border-box;
        overflow: hidden;
      }

      .achievements-catalog__toggle {
        position: relative;
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 12px 16px;
        border: none;
        background: transparent;
        cursor: pointer;
        font: inherit;
        color: var(--text-primary, #212121);
        text-align: left;
      }

      .achievements-catalog__toggle:hover {
        background: var(--bg-hover, rgba(0, 0, 0, 0.04));
      }

      .achievements-catalog__toggle:focus-visible {
        outline: 2px solid var(--text-link, #3b98fd);
        outline-offset: -2px;
      }

      .achievements-catalog__icon {
        font-size: 17px;
        line-height: 1;
      }

      .achievements-catalog__title {
        font-size: 15px;
        font-weight: 700;
      }

      .achievements-catalog__chevron {
        display: inline-block;
        margin-left: auto;
        font-size: 11px;
        color: var(--text-secondary, #555555);
      }

      .achievements-catalog__chevron.is-open {
        transform: rotate(180deg);
      }

      .achievements-catalog__list {
        list-style: none;
        margin: 0;
        padding: 4px 0 8px;
        border-top: 1px solid var(--border-color, #e0e0e0);
      }

      .achievements-catalog__item {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        padding: 8px 16px;
      }

      .achievements-catalog__state-icon {
        flex: 0 0 auto;
        width: 18px;
        text-align: center;
        font-size: 14px;
        line-height: 1.4;
      }

      .achievements-catalog__item.is-earned .achievements-catalog__state-icon {
        color: #2e9e5b;
      }

      .achievements-catalog__body {
        display: flex;
        flex-direction: column;
        gap: 2px;
        flex: 1 1 auto;
      }

      .achievements-catalog__name {
        font-size: 14px;
        font-weight: 600;
        color: var(--text-primary, #212121);
      }

      .achievements-catalog__emoji {
        margin-right: 4px;
      }

      .achievements-catalog__desc {
        font-size: 13px;
        line-height: 1.4;
        color: var(--text-secondary, #555555);
      }

      /* Locked rows are visibly de-emphasised, but state is ALSO carried by the
       lock icon + "Locked" text — never by color alone. */
      .achievements-catalog__item.is-locked .achievements-catalog__name,
      .achievements-catalog__item.is-locked .achievements-catalog__desc {
        opacity: 0.6;
      }

      .achievements-catalog__badge {
        flex: 0 0 auto;
        align-self: center;
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.4px;
      }

      .achievements-catalog__item.is-earned .achievements-catalog__badge {
        color: #2e9e5b;
      }

      .achievements-catalog__item.is-locked .achievements-catalog__badge {
        color: var(--text-secondary, #888888);
      }

      @media (max-width: 600px) {
        .achievements-catalog {
          margin: 12px 8px 8px;
        }
      }
    `
  ]
})
export class AchievementsCatalogComponent {
  /** Every achievement paired with its earned/locked state. Empty → renders nothing. */
  readonly achievements = input<readonly AchievementView[]>([]);

  /** The single expansion state: renders the rows, and drives `aria-expanded` and the chevron's `is-open` class. */
  readonly expanded = signal(false);

  readonly total = computed(() => this.achievements().length);
  readonly earnedCount = computed(() => this.achievements().filter((a) => a.earned).length);

  /** One complete accessible name for the toggle: "Achievements, <earned> of <total>". */
  readonly toggleLabel = computed(
    () => $localize`Achievements, ${this.earnedCount()} of ${this.total()}`
  );

  /**
   * One complete accessible name per achievement row: "<name>. <description>. <Earned|Locked>." The
   * description's own terminal period is dropped so the sentence does not end "..".
   */
  rowLabel(a: AchievementView): string {
    const description = a.description.replace(/\.$/, '');
    const status = a.earned ? $localize`Earned` : $localize`Locked`;
    return $localize`${a.name}. ${description}. ${status}.`;
  }

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  /** The queued post-render reveal for the latest open, if it has not run yet. */
  private pendingReveal: AfterRenderRef | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.cancelPendingReveal());
  }

  toggle(): void {
    const opening = !this.expanded();
    // A reveal queued by an earlier open must never run for a later state (close, reopen, destroy).
    this.cancelPendingReveal();
    this.expanded.set(opening);
    // Only a user-initiated OPEN reveals the list. Closing, or the list simply staying open
    // while Results sections change, never scrolls. Focus is not moved and keys are not intercepted.
    if (opening) {
      this.pendingReveal = afterNextRender(
        () => {
          this.pendingReveal = null;
          this.revealCatalog();
        },
        { injector: this.injector }
      );
    }
  }

  private cancelPendingReveal(): void {
    this.pendingReveal?.destroy();
    this.pendingReveal = null;
  }

  /** Runs after the rows have rendered; immediate (non-animated) scroll. */
  private revealCatalog(): void {
    const el = this.host.nativeElement;
    const toggle = el.querySelector<HTMLElement>('.achievements-catalog__toggle');
    const list = el.querySelector<HTMLElement>('#achievements-catalog-list');
    if (!toggle || !list) return;
    // Keep only the toggle and the FIRST row in view. Scrolling further (to show the whole list) moved the toggle after
    // Narrator had already drawn its outline for it, leaving the outline at the old position (measured: the outline was
    // offset by exactly the reveal delta). The remaining rows are scrolled into view as the user moves down to them.
    const firstRow = list.querySelector<HTMLElement>('.achievements-catalog__item') ?? list;
    const delta = catalogRevealDelta(
      toggle.getBoundingClientRect().top,
      firstRow.getBoundingClientRect().bottom,
      window.innerHeight
    );
    if (Math.abs(delta) >= 1) window.scrollBy({ top: delta, left: 0, behavior: 'instant' });
  }
}
