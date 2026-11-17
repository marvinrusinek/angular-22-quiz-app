import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ScoreVisualComponent } from './score-visual.component';

/**
 * The percentage ring is ONE Narrator group: the ring and the value are hidden
 * from AT and the group exposes a single text node, "<N>% Score", from the same
 * percentage that draws the ring. (It was a role="img", spoken as "graphic".)
 */
describe('ScoreVisualComponent — score ring group', () => {
  let fixture: ComponentFixture<ScoreVisualComponent>;
  let root: HTMLElement;

  const setPct = (p: number): void => {
    fixture.componentRef.setInput('percentage', p);
    fixture.detectChanges();
    TestBed.tick();
  };
  const ring = (): HTMLElement => root.querySelector('.circular-score')!;
  const exposed = (): HTMLElement => ring().querySelector('.intro-exposed-text')!;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [ScoreVisualComponent] });
    fixture = TestBed.createComponent(ScoreVisualComponent);
    root = fixture.nativeElement as HTMLElement;
    setPct(29);
  });

  it('is a role="group", not a graphic, with no aria-label', () => {
    expect(ring().getAttribute('role')).toBe('group');
    expect(ring().hasAttribute('aria-label')).toBe(false);
    expect(ring().querySelector('[role="img"]')).toBeNull();
  });

  it('hides the ring and the value as one unit; the exposed text is outside it; nothing focusable', () => {
    const visible = ring().querySelector('[data-intro-visible]')!;
    expect(visible.getAttribute('aria-hidden')).toBe('true');
    expect(visible.querySelector('svg.score-ring')).not.toBeNull();
    expect(visible.querySelector('.percentage')?.textContent?.trim()).toBe('29%');
    expect(visible.querySelector('.label')?.textContent?.trim()).toBe('Score');
    expect(exposed().closest('[aria-hidden="true"]')).toBeNull();
    expect(ring().querySelectorAll('[tabindex], a, button, input')).toHaveLength(0);
    expect(ring().hasAttribute('tabindex')).toBe(false);
  });

  it('exposes ONE text node, "<N>% Score", never the percentage and label separately', () => {
    expect(exposed().childNodes).toHaveLength(1);
    expect(exposed().firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(exposed().textContent).toBe('29% Score');
    expect(exposed().textContent).toBe(fixture.componentInstance.circleAria());
  });

  it.each([0, 1, 29, 50, 99, 100])('follows the real percentage (%s%)', (p) => {
    setPct(p);
    expect(exposed().textContent).toBe(`${p}% Score`);
    expect(ring().querySelector('.percentage')?.textContent?.trim()).toBe(`${p}%`);
    expect(exposed().childNodes).toHaveLength(1);
  });

  it('keeps the ring drawing from the same percentage (dashoffset)', () => {
    setPct(100);
    const prog = ring().querySelector('.ring-progress') as SVGElement;
    expect(prog.style.strokeDashoffset).toMatch(/^0(px)?$/);
    setPct(0);
    expect(parseFloat(prog.style.strokeDashoffset)).toBeCloseTo(377, 0);
  });
});
