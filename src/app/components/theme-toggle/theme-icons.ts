import { MatIconRegistry } from '@angular/material/icon';
import { DomSanitizer } from '@angular/platform-browser';

/**
 * `dark_mode`/`light_mode` are absent from the self-hosted, subsetted
 * `material-icons.woff2` (confirmed: an isolated canvas glyph-coverage probe
 * against the actual font file renders zero ink for both ligatures, and a
 * live in-app screenshot check showed the same — 0% ink at every theme and
 * viewport tested). Re-subsetting the binary font isn't something this
 * change attempts; per the diagnosis, the theme toggle — used on every
 * route — gets a deterministic, timing-independent, locally-bundled SVG
 * instead, registered once via `MatIconRegistry` rather than depending on
 * font glyph coverage at all.
 *
 * Both are hand-built from plain geometric primitives (a circle for the sun
 * disc, lines for its rays; two circles combined with `fill-rule="evenodd"`
 * for the moon crescent) rather than copied path data, so their correctness
 * can be reasoned about directly instead of trusted from memory.
 */

export const THEME_ICON_DARK_MODE = 'theme-dark-mode';
export const THEME_ICON_LIGHT_MODE = 'theme-light-mode';

const MOON_SVG = `
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" focusable="false">
  <path
    fill-rule="evenodd"
    fill="currentColor"
    d="M12,3 A9,9 0 1,0 12,21 A9,9 0 1,0 12,3 Z
       M15,5.5 A5.5,5.5 0 1,0 15,16.5 A5.5,5.5 0 1,0 15,5.5 Z"
  />
</svg>`.trim();

const SUN_SVG = `
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" focusable="false">
  <circle cx="12" cy="12" r="4" fill="currentColor" />
  <g stroke="currentColor" stroke-width="2" stroke-linecap="round">
    <line x1="18" y1="12" x2="22" y2="12" />
    <line x1="16.24" y1="16.24" x2="19.07" y2="19.07" />
    <line x1="12" y1="18" x2="12" y2="22" />
    <line x1="7.76" y1="16.24" x2="4.93" y2="19.07" />
    <line x1="6" y1="12" x2="2" y2="12" />
    <line x1="7.76" y1="7.76" x2="4.93" y2="4.93" />
    <line x1="12" y1="6" x2="12" y2="2" />
    <line x1="16.24" y1="7.76" x2="19.07" y2="4.93" />
  </g>
</svg>`.trim();

// Keyed on the registry INSTANCE, not a single module-level flag: the real
// app has exactly one root MatIconRegistry for its whole lifetime, but each
// Jest spec's TestBed constructs its own fresh instance — a plain boolean
// flag would stay `true` from an earlier test's registry forever, so a later
// test's brand-new (unregistered) registry would silently never get these
// icons and every `[svgIcon]` lookup against it would fail.
const registeredOn = new WeakSet<MatIconRegistry>();

/** Idempotent per registry instance — safe to call from every `ThemeToggleComponent` instance. */
export function registerThemeIcons(iconRegistry: MatIconRegistry, sanitizer: DomSanitizer): void {
  if (registeredOn.has(iconRegistry)) return;
  registeredOn.add(iconRegistry);
  iconRegistry.addSvgIconLiteral(THEME_ICON_DARK_MODE, sanitizer.bypassSecurityTrustHtml(MOON_SVG));
  iconRegistry.addSvgIconLiteral(THEME_ICON_LIGHT_MODE, sanitizer.bypassSecurityTrustHtml(SUN_SVG));
}
