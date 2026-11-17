import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ScoreVisualComponent } from './score-visual.component';

/**
 * The Correct / Incorrect / Timed Out breakdown is ONE Narrator group: the
 * visible rows are hidden from AT and the group exposes a single text node,
 * built from the same signals that render the visible rows. (It was a
 * role="img", which Narrator spoke as "graphic".)
 */
describe('ScoreVisualComponent — score breakdown group', () => {
  let fixture: ComponentFixture<ScoreVisualComponent>;
  let root: HTMLElement;

  const setCounts = (correct: number, incorrect: number, timedOut: number): void => {
    fixture.componentRef.setInput('correctCount', correct);
    fixture.componentRef.setInput('incorrectCount', incorrect);
    fixture.componentRef.setInput('timedOutCount', timedOut);
    fixture.detectChanges();
    TestBed.tick();
  };
  const group = (): HTMLElement => root.querySelector('.score-breakdown')!;
  const exposed = (): HTMLElement => group().querySelector('.intro-exposed-text')!;
  const visibleRows = (): string[] =>
    Array.from(group().querySelectorAll('.breakdown-item')).map((r) =>
      (r.textContent ?? '').trim()
    );

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [ScoreVisualComponent] });
    fixture = TestBed.createComponent(ScoreVisualComponent);
    root = fixture.nativeElement as HTMLElement;
    setCounts(7, 0, 0);
  });

  it('is a role="group", not a graphic', () => {
    expect(group().getAttribute('role')).toBe('group');
    expect(group().hasAttribute('aria-label')).toBe(false);
  });

  it('keeps the existing keyboard behaviour: no new Tab stop, nothing focusable inside', () => {
    expect(group().hasAttribute('tabindex')).toBe(false);
    expect(group().querySelectorAll('[tabindex], a, button, input')).toHaveLength(0);
  });

  it('hides the visible rows from assistive technology and keeps their symbols and colours', () => {
    const visible = group().querySelector('[data-intro-visible]')!;
    expect(visible.getAttribute('aria-hidden')).toBe('true');
    expect(visibleRows()).toEqual(['✔ 7 Correct', '✖ 0 Incorrect', '⏱ 0 Timed Out']);
    for (const cls of ['correct', 'incorrect', 'timed-out']) {
      expect(visible.querySelector('.breakdown-item.' + cls)).not.toBeNull();
    }
  });

  it('exposes exactly ONE text node, one line per row, outside the hidden wrapper', () => {
    expect(exposed().childNodes).toHaveLength(1);
    expect(exposed().firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(exposed().textContent).toBe('7 Correct\n0 Incorrect\n0 Timed Out');
    expect(exposed().closest('[aria-hidden="true"]')).toBeNull();
  });

  it('uses the same signals for the visible rows and the exposed text', () => {
    const c = fixture.componentInstance;
    expect(exposed().textContent).toBe(c.breakdownExposedText());
    expect(c.breakdownExposedText()).toBe(
      [c.correctText(), c.incorrectText(), c.timedOutText()].join('\n')
    );
    // Every visible row is its signal text plus the symbol, and nothing else.
    expect(visibleRows().map((r) => r.slice(2))).toEqual(c.breakdownExposedText().split('\n'));
  });

  it('follows the real counts', () => {
    setCounts(3, 4, 2);
    expect(visibleRows()).toEqual(['✔ 3 Correct', '✖ 4 Incorrect', '⏱ 2 Timed Out']);
    expect(exposed().textContent).toBe('3 Correct\n4 Incorrect\n2 Timed Out');
    expect(exposed().childNodes).toHaveLength(1);
  });

  it('leaves the other score visuals as they were (the stars stay a named graphic; the ring and badge are groups)', () => {
    expect(root.querySelector('.circular-score')?.getAttribute('role')).toBe('group'); // see score-visual-ring.spec.ts
    expect(root.querySelector('.star-icons')?.getAttribute('role')).toBe('img');
    expect(root.querySelector('.achievement-badge')?.getAttribute('role')).toBe('group'); // now a group (see score-visual-badge.spec.ts)
  });
});
