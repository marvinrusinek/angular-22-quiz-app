import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ScoreVisualComponent } from './score-visual.component';

/**
 * The star rating is a NEUTRAL wrapper (no role, so no "group" and no "graphic" is announced): the five stars are
 * hidden from AT and the wrapper holds a single text node, "N Stars" ("1 Star" for one), from the same count that
 * fills the stars. (It was a role="img", spoken as "graphic".)
 */
describe('ScoreVisualComponent — star rating', () => {
  let fixture: ComponentFixture<ScoreVisualComponent>;
  let root: HTMLElement;

  const setStars = (n: number): void => {
    fixture.componentRef.setInput('starCount', n);
    fixture.detectChanges();
    TestBed.tick();
  };
  const wrapper = (): HTMLElement => root.querySelector('.star-icons')!;
  const exposed = (): HTMLElement => wrapper().querySelector('.intro-exposed-text')!;
  const stars = (): HTMLElement[] => Array.from(wrapper().querySelectorAll('.star'));

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [ScoreVisualComponent] });
    fixture = TestBed.createComponent(ScoreVisualComponent);
    root = fixture.nativeElement as HTMLElement;
    setStars(3);
  });

  it('is a neutral wrapper: no role, no aria-label, no roledescription, nothing hiding it', () => {
    expect(wrapper().hasAttribute('role')).toBe(false);
    expect(wrapper().hasAttribute('aria-label')).toBe(false);
    expect(wrapper().hasAttribute('aria-roledescription')).toBe(false);
    expect(wrapper().hasAttribute('aria-hidden')).toBe(false);
    expect(wrapper().querySelector('[role]')).toBeNull();
    expect(root.querySelector('.star-rating [role="img"], .star-rating [role="group"]')).toBeNull();
  });

  it('hides all five stars as one unit; the exposed text is outside it; nothing focusable', () => {
    const visible = wrapper().querySelector('[data-intro-visible]')!;
    expect(visible.getAttribute('aria-hidden')).toBe('true');
    expect(stars()).toHaveLength(5);
    for (const s of stars()) expect(visible.contains(s)).toBe(true);
    expect(exposed().closest('[aria-hidden="true"]')).toBeNull();
    expect(wrapper().querySelectorAll('[tabindex], a, button, input')).toHaveLength(0);
    expect(wrapper().hasAttribute('tabindex')).toBe(false);
  });

  it('exposes ONE text node, "N Stars", never the stars one by one', () => {
    expect(exposed().childNodes).toHaveLength(1);
    expect(exposed().firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(exposed().textContent).toBe('3 Stars');
    expect(exposed().textContent).toBe(fixture.componentInstance.starsAria());
    expect(exposed().textContent).not.toContain('⭐');
  });

  it.each([
    [1, '1 Star'],
    [2, '2 Stars'],
    [3, '3 Stars'],
    [4, '4 Stars'],
    [5, '5 Stars']
  ])('follows the real rating (%s): "%s", and the filled stars match', (n, text) => {
    setStars(n);
    expect(exposed().textContent).toBe(text);
    expect(exposed().childNodes).toHaveLength(1);
    expect(stars().filter((s) => s.classList.contains('filled'))).toHaveLength(n);
    expect(stars().filter((s) => s.classList.contains('empty'))).toHaveLength(5 - n);
  });

  it('marks exactly one star as the typography reference', () => {
    expect(wrapper().querySelectorAll('[data-intro-font-ref]')).toHaveLength(1);
    expect(stars()[0].hasAttribute('data-intro-font-ref')).toBe(true);
  });
});
