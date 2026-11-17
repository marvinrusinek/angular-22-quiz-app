import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ScoreVisualComponent } from './score-visual.component';

/**
 * The achievement badge ("💪 Keep Practicing!") is ONE Narrator group: the icon
 * and the text are hidden from AT and the group exposes a single text node, the
 * badge text, from the same signal that renders the visible text. (It was a
 * role="img", which Narrator spoke as "graphic".)
 */
describe('ScoreVisualComponent — achievement badge group', () => {
  let fixture: ComponentFixture<ScoreVisualComponent>;
  let root: HTMLElement;

  const setLevel = (level: 'excellent' | 'good' | 'poor'): void => {
    fixture.componentRef.setInput('feedbackLevel', level);
    fixture.detectChanges();
    TestBed.tick();
  };
  const badge = (): HTMLElement => root.querySelector('.achievement-badge')!;
  const exposed = (): HTMLElement => badge().querySelector('.intro-exposed-text')!;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [ScoreVisualComponent] });
    fixture = TestBed.createComponent(ScoreVisualComponent);
    root = fixture.nativeElement as HTMLElement;
    setLevel('poor');
  });

  it('is a role="group", not a graphic, with no aria-label', () => {
    expect(badge().getAttribute('role')).toBe('group');
    expect(badge().hasAttribute('aria-label')).toBe(false);
    expect(badge().querySelector('[role="img"]')).toBeNull();
  });

  it('hides the icon and the text from AT as one unit; the exposed text is outside it', () => {
    const visible = badge().querySelector('[data-intro-visible]')!;
    expect(visible.getAttribute('aria-hidden')).toBe('true');
    expect(visible.querySelector('.badge-icon')?.textContent?.trim()).toBe('💪');
    expect(visible.querySelector('.badge-text')?.textContent?.trim()).toBe('Keep Practicing!');
    expect(exposed().closest('[aria-hidden="true"]')).toBeNull();
  });

  it('exposes exactly ONE text node, the badge text, without the emoji', () => {
    expect(exposed().childNodes).toHaveLength(1);
    expect(exposed().firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(exposed().textContent).toBe('Keep Practicing!');
    expect(exposed().textContent).not.toContain('💪');
  });

  it('adds no Tab stop and nothing interactive', () => {
    expect(badge().hasAttribute('tabindex')).toBe(false);
    expect(badge().querySelectorAll('[tabindex], a, button, input')).toHaveLength(0);
  });

  it.each([
    ['excellent', '🏆', 'Excellent Performance!', 'excellent'],
    ['good', '🥈', 'Good Job!', 'good'],
    ['poor', '💪', 'Keep Practicing!', 'needs-work']
  ] as const)('%s: visible icon/text, exposed text and style class agree', (level, icon, text, cls) => {
    setLevel(level);
    expect(badge().classList.contains(cls)).toBe(true);
    expect(badge().querySelector('.badge-icon')?.textContent?.trim()).toBe(icon);
    expect(badge().querySelector('.badge-text')?.textContent?.trim()).toBe(text);
    expect(exposed().textContent).toBe(text);
    expect(exposed().textContent).toBe(fixture.componentInstance.badgeText());
    expect(exposed().childNodes).toHaveLength(1);
  });

  it('is a single badge (no duplicate level elements)', () => {
    for (const l of ['excellent', 'good', 'poor'] as const) {
      setLevel(l);
      expect(root.querySelectorAll('.achievement-badge')).toHaveLength(1);
    }
  });
});
