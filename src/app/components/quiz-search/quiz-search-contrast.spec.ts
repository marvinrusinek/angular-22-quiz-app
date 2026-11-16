import { compile } from 'sass';
import { join } from 'path';

/** WCAG relative-luminance contrast ratio for two #rrggbb colors. */
function contrast(a: string, b: string): number {
  const lum = (hex: string): number => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const v = parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * The dark-theme search text was near-black on the dark surface (about 1.5:1)
 * because the dark rule lived in the PARENT's stylesheet and cannot reach this
 * component's input under emulated view encapsulation. The component now owns it.
 */
describe('QuizSearchComponent — typed text contrast', () => {
  const css = compile(join(__dirname, 'quiz-search.component.scss'), {
    loadPaths: [join(__dirname, '../../../')]
  }).css;
  const block = (selector: string): string => {
    const start = css.indexOf(`${selector} {`);
    return start < 0 ? '' : css.slice(start, css.indexOf('}', start));
  };

  const DARK_SURFACE = '#2a2d38'; // --qd-surface in the dark theme
  const DARK_TEXT = '#eceef7'; // --qd-text in the dark theme

  it('light theme: the input text stays dark on the white field', () => {
    const color = /color:\s*(#[0-9a-f]{6})/i.exec(block('.quiz-search .search-input'))?.[1];
    expect(color).toBeDefined();
    expect(contrast(color!, '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });

  it('dark theme: this component sets a light input color itself', () => {
    const dark = block(':host-context([data-theme=dark]) .quiz-search .search-input');
    expect(dark).toMatch(/color:\s*var\(--qd-text,\s*#eceef7\)/);
  });

  it('dark theme: that text (variable and fallback) is at least 4.5:1 on the surface', () => {
    expect(contrast(DARK_TEXT, DARK_SURFACE)).toBeGreaterThanOrEqual(4.5);
  });

  it('does not rely on ::ng-deep', () => {
    expect(css).not.toContain('ng-deep');
  });
});
