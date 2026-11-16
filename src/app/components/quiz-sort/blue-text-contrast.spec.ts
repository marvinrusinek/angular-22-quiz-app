import { compile } from 'sass';
import { join } from 'path';

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
 * Dodger blue (#007aff) is only 4.0:1 on white, short of WCAG AA (4.5:1) for the
 * 14px bold text of the Difficulty / A–Z buttons and the difficulty dropdown.
 * Their TEXT uses the darker $dodger-blue-text; borders and focus rings keep the
 * original blue, so the look is unchanged apart from a slightly deeper label.
 */
describe('Filter and sort controls — blue text contrast', () => {
  const load = (rel: string): string =>
    compile(join(__dirname, rel), { loadPaths: [join(__dirname, '../../../')] }).css;
  const WHITE = '#ffffff';
  const HOVER = '#eeeeee';
  const OLD_BLUE = '#007aff';

  const sort = load('quiz-sort.component.scss');
  const filter = load('../quiz-difficulty-filter/quiz-difficulty-filter.component.scss');

  const sortBlock = sort.slice(
    sort.indexOf('.quiz-sort .sort-btn {'),
    sort.indexOf('}', sort.indexOf('.quiz-sort .sort-btn {'))
  );
  const sortColor = /\bcolor:\s*(#[0-9a-f]{6})/i.exec(sortBlock)?.[1];
  const filterColor =
    /--mat-select-enabled-trigger-text-color:\s*(#[0-9a-f]{6})/i.exec(filter)?.[1];

  it('the old blue really was below AA (guards the premise)', () => {
    expect(contrast(OLD_BLUE, WHITE)).toBeLessThan(4.5);
  });

  it.each([
    ['sort buttons', sortColor],
    ['difficulty dropdown', filterColor]
  ])('%s: text is at least 4.5:1 on white and on the hover fill', (_name, color) => {
    expect(color).toBeDefined();
    expect(color!.toLowerCase()).not.toBe(OLD_BLUE);
    expect(contrast(color!, WHITE)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(color!, HOVER)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the original blue for borders and the focus ring', () => {
    expect(sortBlock).toContain('border: 1px solid #007aff');
    expect(sort).toContain('outline: 2px solid #007aff');
    expect(filter).toContain('border: 1px solid #007aff');
  });
});
