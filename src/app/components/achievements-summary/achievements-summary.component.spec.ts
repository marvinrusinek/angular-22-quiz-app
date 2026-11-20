import { ComponentFixture, TestBed } from '@angular/core/testing';

import { AchievementsSummaryComponent } from './achievements-summary.component';

describe('AchievementsSummaryComponent', () => {
  let fixture: ComponentFixture<AchievementsSummaryComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [AchievementsSummaryComponent] });
    fixture = TestBed.createComponent(AchievementsSummaryComponent);
  });

  const setCounts = (earned: number, total: number): void => {
    fixture.componentRef.setInput('earned', earned);
    fixture.componentRef.setInput('total', total);
    fixture.detectChanges();
  };
  const root = (): HTMLElement | null =>
    fixture.nativeElement.querySelector('.achievements-summary');

  it('renders the "X / N" progress when there is a positive total', () => {
    setCounts(3, 6);
    expect(root()).toBeTruthy();
    expect(root()?.textContent?.replace(/\s+/g, ' ')).toContain('3 / 6');
  });

  it('renders nothing when the total is zero', () => {
    setCounts(0, 0);
    expect(root()).toBeNull();
  });

  // A neutral container: the visible label and count ARE the accessible content (read once), with no region/landmark, group,
  // graphic, label override or live region. Only the decorative trophy is hidden. Narrator behaviour is verified by hand.
  it('is a neutral container with no region, landmark, group, graphic, name override or live region', () => {
    setCounts(2, 6);
    const el = root() as HTMLElement;
    expect(el.tagName).toBe('DIV');
    expect(el.className).toBe('achievements-summary');
    expect(el.getAttributeNames()).toEqual(['class']);
    expect(fixture.nativeElement.querySelector('section, [role], [aria-label], [aria-labelledby], [aria-live], [tabindex]')).toBeNull();
  });

  // Visible text keeps the slash and is aria-hidden; ONE screen-reader-only text node carries the spoken phrase ("of"). Both are single
  // text nodes with no child elements. Narrator behaviour is verified by hand; these pin structure and text.
  it('renders the visible phrase with the slash as exactly one text node, aria-hidden, and no child elements', () => {
    setCounts(6, 6);
    const el = root() as HTMLElement;
    expect(Array.from(el.children).map((c) => c.className)).toEqual(['achievements-summary__icon', 'achievements-summary__textwrap']);
    const wrap = el.querySelector(':scope > .achievements-summary__textwrap') as HTMLElement;
    expect(wrap.tagName).toBe('SPAN');
    expect(wrap.getAttributeNames()).toEqual(['class']); // neutral wrapper: no role, name or aria-hidden
    expect(Array.from(wrap.children).map((c) => c.className)).toEqual(['achievements-summary__text', 'achievements-summary__sr']);
    const text = wrap.querySelector(':scope > .achievements-summary__text') as HTMLElement;
    expect(text.tagName).toBe('SPAN');
    expect(text.getAttribute('aria-hidden')).toBe('true');
    expect(text.getAttributeNames().sort()).toEqual(['aria-hidden', 'class']);
    expect(text.childNodes).toHaveLength(1);
    expect(text.firstChild!.nodeType).toBe(Node.TEXT_NODE);
    expect(text.children).toHaveLength(0);
    expect(text.textContent).toBe('Achievements 6 / 6'); // the slash stays visible for every count, 6 / 6 included
    expect(fixture.componentInstance.summaryText()).toBe('Achievements 6 / 6');
  });

  it('exposes ONE complete spoken phrase "Achievements N of M" in a screen-reader-only text node', () => {
    setCounts(6, 6);
    const el = root() as HTMLElement;
    const sr = el.querySelector(':scope > .achievements-summary__textwrap > .achievements-summary__sr') as HTMLElement;
    expect(sr.tagName).toBe('SPAN');
    expect(sr.getAttributeNames()).toEqual(['class']);
    expect(sr.childNodes).toHaveLength(1);
    expect(sr.firstChild!.nodeType).toBe(Node.TEXT_NODE);
    expect(sr.children).toHaveLength(0);
    expect(sr.textContent).toBe('Achievements 6 of 6');
    expect(sr.closest('[aria-hidden]')).toBeNull();
    expect(sr.hasAttribute('hidden')).toBe(false); // visually hidden by CSS only; never hidden / display:none
    expect(fixture.componentInstance.spokenText()).toBe('Achievements 6 of 6');
  });

  it('has the trophy and the visible slash text as the only aria-hidden content, and no role, name, live region or focus behavior', () => {
    setCounts(2, 6);
    const el = root() as HTMLElement;
    const hidden = Array.from(el.querySelectorAll('[aria-hidden]')).map((e) => e.className);
    expect(hidden).toEqual(['achievements-summary__icon', 'achievements-summary__text']); // the wrapper and the spoken text are NOT aria-hidden
    expect(el.querySelector('[role], [aria-label], [aria-labelledby], [aria-live], [tabindex], section')).toBeNull();
    expect(el.tagName).toBe('DIV');
  });

  it('follows the real counts: slash visible and "of" spoken for every count, including zero earned', () => {
    for (const [e, n] of [[0, 6], [1, 6], [6, 6], [12, 30]]) {
      setCounts(e, n);
      const text = root()?.querySelector('.achievements-summary__text') as HTMLElement;
      const sr = root()?.querySelector('.achievements-summary__sr') as HTMLElement;
      expect(text.textContent).toBe('Achievements ' + e + ' / ' + n);
      expect(sr.textContent).toBe('Achievements ' + e + ' of ' + n);
      expect(text.childNodes).toHaveLength(1);
      expect(sr.childNodes).toHaveLength(1);
    }
  });
});
