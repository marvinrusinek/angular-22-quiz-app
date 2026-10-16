import { MatIconRegistry } from '@angular/material/icon';
import { DomSanitizer } from '@angular/platform-browser';

/**
 * `quiz` is absent from the self-hosted, subsetted `material-icons.woff2`
 * (confirmed: a real-rendered-pixel check — a Playwright screenshot of the
 * live `<mat-icon>quiz</mat-icon>` element, not a synthetic canvas redraw —
 * found it blank on both localhost and a local production build, while a
 * sibling icon in the same subset rendered normally). Same bug class, same
 * fix, as `theme-icons.ts`'s `dark_mode`/`light_mode` SVGs: a locally-
 * bundled SVG registered once via `MatIconRegistry`, independent of font
 * glyph coverage.
 *
 * Path data is the OFFICIAL classic Material Icons "quiz" glyph (the same
 * icon family already self-hosted in this app, codepoint 0xebf5), taken
 * verbatim from Google's own `@material-icons/svg` package (Apache-2.0,
 * mirrors google/material-design-icons) rather than reproduced from memory
 * — unlike the sun/moon icons above, "quiz" is a specific pictograph, not a
 * simple primitive shape that can be safely hand-built. `fill="currentColor"`
 * added on the root (the source SVG defaults to black) so it inherits
 * `.meta-item`'s theme-aware color exactly like the ligature icon it
 * replaces.
 */

export const QUESTION_COUNT_ICON = 'question-count-quiz';

const QUIZ_SVG = `
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor" focusable="false">
  <path d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6z"/>
  <path d="M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-5.99 13c-.59 0-1.05-.47-1.05-1.05c0-.59.47-1.04 1.05-1.04c.59 0 1.04.45 1.04 1.04c-.01.58-.45 1.05-1.04 1.05zm2.5-6.17c-.63.93-1.23 1.21-1.56 1.81c-.13.24-.18.4-.18 1.18h-1.52c0-.41-.06-1.08.26-1.65c.41-.73 1.18-1.16 1.63-1.8c.48-.68.21-1.94-1.14-1.94c-.88 0-1.32.67-1.5 1.23l-1.37-.57C11.51 5.96 12.52 5 13.99 5c1.23 0 2.08.56 2.51 1.26c.37.61.58 1.73.01 2.57z"/>
</svg>`.trim();

// Same per-registry-instance idempotency rationale as theme-icons.ts's
// own WeakSet (a fresh TestBed MatIconRegistry per Jest spec must not be
// skipped by an earlier test's registration).
const registeredOn = new WeakSet<MatIconRegistry>();

/** Idempotent per registry instance — safe to call from every `IntroductionComponent` instance. */
export function registerQuestionCountIcon(iconRegistry: MatIconRegistry, sanitizer: DomSanitizer): void {
  if (registeredOn.has(iconRegistry)) return;
  registeredOn.add(iconRegistry);
  iconRegistry.addSvgIconLiteral(QUESTION_COUNT_ICON, sanitizer.bypassSecurityTrustHtml(QUIZ_SVG));
}
