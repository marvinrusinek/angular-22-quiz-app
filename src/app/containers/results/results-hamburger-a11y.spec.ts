import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Hamburger menu semantics on the Topic Quiz Results header.
 *
 * ResultsComponent has too many collaborators to render in isolation, so this
 * checks the template contract directly; the rendered behavior (aria-expanded
 * flipping, the menu id, the accessible names) is covered by the browser check
 * run alongside this change.
 */
describe('Results hamburger menu — template contract', () => {
  const html = readFileSync(join(__dirname, 'results.component.html'), 'utf8');
  const toggle = /<button[^>]*class="hamburger-btn"[\s\S]*?>/.exec(html)![0];
  const nav = /<nav[\s\S]*?>/.exec(html)![0];

  it('the toggle exposes its expanded state from the menuOpen signal', () => {
    expect(toggle).toContain('[attr.aria-expanded]="menuOpen()"');
  });

  it('the toggle references the menu only while it exists', () => {
    expect(toggle).toContain(
      `[attr.aria-controls]="menuOpen() ? 'results-nav-menu' : null"`
    );
    expect(nav).toContain('id="results-nav-menu"');
  });

  it('keeps its existing accessible name', () => {
    expect(toggle).toContain('aria-label="Toggle navigation menu"');
  });

  it('the navigation has a meaningful, translatable name', () => {
    expect(nav).toContain('aria-label="Results sections"');
    expect(nav).toContain('i18n-aria-label');
  });

  it('every decorative emoji is hidden from assistive technology', () => {
    const icons = html.match(/<span class="nav-icon"[^>]*>/g) ?? [];
    expect(icons).toHaveLength(6);
    for (const icon of icons) expect(icon).toContain('aria-hidden="true"');
    expect(html).not.toMatch(/<span class="nav-icon">/);
  });

  it('the menu items keep their handlers and visible text', () => {
    for (const label of [
      'Score Analysis',
      'Summary Report',
      'Quiz Review',
      'High Scores',
      'Resources',
      'Return to Quiz Selection'
    ]) {
      expect(html).toContain(`<span i18n>${label}</span>`);
    }
    expect(html).toContain(`(click)="setActiveSection('score')"`);
    expect(html).toContain('(click)="selectQuiz()"');
  });
});
