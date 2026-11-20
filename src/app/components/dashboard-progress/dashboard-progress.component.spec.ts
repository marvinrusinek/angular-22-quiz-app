import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router, UrlTree } from '@angular/router';

import { ProgressSummary } from '@shared/models';
import { DashboardProgressComponent } from './dashboard-progress.component';

function summary(over: Partial<ProgressSummary> = {}): ProgressSummary {
  return {
    completedCount: 0,
    totalCount: 20,
    completionPercentage: 0,
    byDifficulty: [],
    strongestQuiz: null,
    weakestQuiz: null,
    averageScore: 0,
    perfectScores: 0,
    questionsCompleted: 0,
    ...over
  };
}

describe('DashboardProgressComponent', () => {
  let fixture: ComponentFixture<DashboardProgressComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [DashboardProgressComponent],
      providers: [provideRouter([])]
    });
    fixture = TestBed.createComponent(DashboardProgressComponent);
  });

  const set = (s: ProgressSummary | null): void => {
    fixture.componentRef.setInput('summary', s);
    fixture.detectChanges();
  };
  const root = (): HTMLElement => fixture.nativeElement;
  const stats = (): HTMLElement[] => Array.from(root().querySelectorAll<HTMLElement>('.dp__stats > .dp__stat'));
  /** Each statistic with a value is ONE plain paragraph (a single text node). The only group left is the average's unavailable state. */
  const plainStats = (): HTMLElement[] => Array.from(root().querySelectorAll<HTMLElement>('.dp__stats > .dp__stat > p.dp__plain-stat'));
  const plainStat = (): HTMLElement => root().querySelector('.dp__stat--done > p.dp__plain-stat') as HTMLElement;
  const groups = (): HTMLElement[] => Array.from(root().querySelectorAll<HTMLElement>('.dp__stats .dp__group'));
  const NBSP = / /g;
  const statEls = (): HTMLElement[] => Array.from(root().querySelectorAll<HTMLElement>('.dp__stats > .dp__stat'));
  /** The visible value of each statistic: a paragraph's first word, or the value element of a group. */
  const values = (): string[] =>
    statEls().map((s) => {
      const p = s.querySelector('p.dp__plain-stat');
      return p ? (p.textContent ?? '').split(/[  ]/)[0] : (s.querySelector('.dp__value')?.textContent ?? '').trim();
    });
  /** The one complete phrase of each statistic: a paragraph's text, or the exposed text item of a group (the directive host). */
  const spoken = (): string[] =>
    statEls().map((s) => {
      const p = s.querySelector('p.dp__plain-stat');
      if (p) return p.textContent ?? '';
      const hosts = s.querySelectorAll('.dp__group > .intro-exposed-text');
      expect(hosts).toHaveLength(1);
      return hosts[0].textContent ?? '';
    });

  it('renders the supplied statistics', () => {
    set(summary({ completedCount: 12, averageScore: 78, perfectScores: 5 }));
    expect(values()).toEqual(['12', '78%', '5']);
  });

  it('shows zeros and an em dash average when nothing is completed', () => {
    set(summary());
    expect(values()).toEqual(['0', '—', '0']);
    expect(root().textContent).not.toContain('NaN');
  });

  it('tolerates a missing summary', () => {
    set(null);
    expect(values()).toEqual(['0', '—', '0']);
  });

  // Each statistic is its own group exposing ONE complete phrase; the visible value and label are hidden from AT as one
  // unit and there is no second, off-screen copy. Narrator behaviour is verified by hand; these pin structure and text.
  it('exposes one complete phrase per statistic, from the existing localized labels', () => {
    set(summary({ completedCount: 12, averageScore: 78, perfectScores: 5 }));
    const plain = (s: string[]): string[] => s.map((x) => x.replace(NBSP, ' '));
    expect(plain(spoken())).toEqual(['12 Quizzes Completed', '78% Average Score', '5 Perfect Scores']);
    const c = fixture.componentInstance;
    expect(plain(spoken())).toEqual([c.completedLabel(), c.averageLabel(), c.perfectLabel()]);
  });

  // Every statistic with a value is ONE text node ("<value> <label>", label words joined by no-break spaces) in a plain paragraph,
  // with no spans, hidden copy or group: the value-above-label look is drawn by CSS (::first-line).
  it('renders each filled statistic as one text node in a plain paragraph, with no spans, group, hidden copy or ARIA', () => {
    set(summary({ completedCount: 12, averageScore: 97, perfectScores: 16 }));
    expect(plainStats()).toHaveLength(3);
    expect(plainStats().map((p) => p.textContent)).toEqual(['12 Quizzes Completed', '97% Average Score', '16 Perfect Scores']);
    plainStats().forEach((p) => {
      expect(p.tagName).toBe('P');
      expect(p.childNodes).toHaveLength(1);
      expect(p.firstChild!.nodeType).toBe(Node.TEXT_NODE);
      expect(p.getAttributeNames()).toEqual(['class']);
      expect(p.querySelector('*')).toBeNull();
    });
    expect(root().querySelector('.dp__stats .dp__group, .dp__stats .dp__value, .dp__stats .dp__label, .dp__stats .intro-exposed-text')).toBeNull();
    // the only aria-hidden content in the statistics is the decorative icons
    const hidden = Array.from(root().querySelectorAll('.dp__stats [aria-hidden="true"]'));
    expect(hidden.every((e) => e.classList.contains('dp__icon') || e.closest('.dp__icon') !== null)).toBe(true);
  });

  it('keeps the fitted group only for the average unavailable state: visible dash + label hidden as one unit, meaningful message exposed', () => {
    set(summary());
    expect(groups()).toHaveLength(1);
    const g = groups()[0];
    expect(g.closest('.dp__stat--avg')).not.toBeNull();
    expect((g.querySelector(':scope > .intro-exposed-text') as HTMLElement).textContent).toBe('Average score not available yet');
    expect((g.querySelector('.dp__value') as HTMLElement).textContent!.trim()).toBe('—');
    expect(plainStats()).toHaveLength(2); // the zero counts are still plain paragraphs
  });

  it('keeps the empty-state wording: zero counts and "Average score not available yet"', () => {
    set(summary());
    expect(spoken()).toEqual(['0 Quizzes Completed', 'Average score not available yet', '0 Perfect Scores']);
    set(null);
    expect(spoken()[1]).toBe('Average score not available yet');
  });

  it('hides the visible value and label of the unavailable-average group as one unit, never display:none, with decorative icons outside', () => {
    set(summary());
    expect(groups()).toHaveLength(1);
    groups().forEach((g) => {
      expect(g.getAttribute('role')).toBe('group');
      expect(g.hasAttribute('tabindex')).toBe(false);
      const visible = g.querySelector(':scope > [data-intro-visible]') as HTMLElement;
      expect(visible.getAttribute('aria-hidden')).toBe('true');
      expect(visible.hasAttribute('hidden')).toBe(false);
      expect(visible.querySelector('.dp__value')).not.toBeNull();
      expect(visible.querySelector('.dp__label')!.hasAttribute('data-intro-font-ref')).toBe(true);
      expect(visible.querySelector('.dp__icon')).toBeNull(); // the icon is outside the group
    });
    root().querySelectorAll('.dp__icon').forEach((i) => expect(i.getAttribute('aria-hidden')).toBe('true'));
  });

  // Plain neutral containers, not a native list: no statistic may be announced with a position such as "1 of 3", and the
  // spoken first phrase carries no total ("12 Quizzes Completed", not "12 of 20 quizzes completed"). Speech is verified by hand.
  it('uses neutral containers: no list or list items, classes retained, no roles or position attributes on the structure', () => {
    set(summary({ completedCount: 12, totalCount: 20, averageScore: 78, perfectScores: 5 }));
    const container = root().querySelector('.dp__stats') as HTMLElement;
    expect(container.tagName).toBe('DIV');
    expect(root().querySelector('ul, ol, li')).toBeNull();
    expect(container.hasAttribute('role')).toBe(false);
    const stats = Array.from(container.children) as HTMLElement[];
    expect(stats.map((s) => s.tagName)).toEqual(['DIV', 'DIV', 'DIV']);
    expect(stats.map((s) => s.className)).toEqual(['dp__stat dp__stat--done', 'dp__stat dp__stat--avg', 'dp__stat dp__stat--perfect']);
    stats.forEach((s) => expect(s.getAttributeNames()).toEqual(['class']));
    expect(root().querySelector('[aria-posinset], [aria-setsize]')).toBeNull();
  });

  it('follows the real values: dynamic, zero and large counts keep one text node and one phrase each', () => {
    for (const [n, avg, perfect] of [[1, 0, 0], [7, 55, 1], [12, 97, 16], [100, 100, 100]]) {
      set(summary({ completedCount: n, averageScore: avg, perfectScores: perfect }));
      const c = fixture.componentInstance;
      expect(plainStats().map((p) => p.childNodes.length)).toEqual([1, 1, 1]);
      expect(plainStats().map((p) => p.textContent!.replace(NBSP, ' '))).toEqual([n + ' Quizzes Completed', avg + '% Average Score', perfect + ' Perfect Scores']);
      expect([c.completedLabel(), c.averageLabel(), c.perfectLabel()]).toEqual([n + ' Quizzes Completed', avg + '% Average Score', perfect + ' Perfect Scores']);
    }
    // zero completed: the average is unavailable (never an invented 0%), zero counts stay plain paragraphs
    set(summary({ completedCount: 0, averageScore: 0, perfectScores: 0 }));
    expect(spoken().map((s) => s.replace(NBSP, ' '))).toEqual(['0 Quizzes Completed', 'Average score not available yet', '0 Perfect Scores']);
    expect(root().textContent).not.toContain('0% Average');
    expect(fixture.componentInstance.averageAvailable()).toBe(false);
  });

  it('does not put the total in the spoken first phrase, while the total is still computed', () => {
    set(summary({ completedCount: 12, totalCount: 20 }));
    expect(fixture.componentInstance.total()).toBe(20);
    expect(fixture.componentInstance.completedLabel()).toBe('12 Quizzes Completed');
    expect(fixture.componentInstance.completedLabel()).not.toContain('of');
    expect(fixture.componentInstance.completedLabel()).not.toContain('20');
  });

  it('has no off-screen duplicate text and no extra focus stops', () => {
    set(summary({ completedCount: 12, averageScore: 78, perfectScores: 5 }));
    expect(root().querySelector('.dp__sr')).toBeNull();
    expect(root().querySelector('.dp__stats .visually-hidden')).toBeNull();
    expect(root().querySelectorAll('.dp__stats .intro-exposed-text')).toHaveLength(0); // filled: no exposed-text hosts at all
    expect(root().querySelectorAll('.dp__stats [tabindex]')).toHaveLength(0);
  });

  it('is a labelled region with an h2 and a native View Progress button', () => {
    set(summary());
    const region = root().querySelector('section')!;
    const heading = root().querySelector('h2')!;
    expect(region.getAttribute('aria-labelledby')).toBe(heading.id);
    expect(heading.textContent).toContain('Your Progress');
    const button = root().querySelector('button.dp__link') as HTMLButtonElement;
    expect(button.type).toBe('button');
    expect(button.textContent).toContain('View Progress');
    expect(root().querySelector('a.dp__link')).toBeNull();
  });

  it('places all three statistics before View Progress in document order', () => {
    const examples = [
      summary(),
      summary({ completedCount: 20, averageScore: 97, perfectScores: 16 })
    ];
    for (const progress of examples) {
      set(progress);
      const heading = root().querySelector('h2')!;
      const statistics = statEls();
      const button = root().querySelector('button.dp__link')!;
      expect(statistics).toHaveLength(3);
      for (const statistic of statistics) {
        expect(heading.compareDocumentPosition(statistic) &
          Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(statistic.compareDocumentPosition(button) &
          Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
    }
  });

  it('navigates to /progress once when View Progress is activated', () => {
    const router = TestBed.inject(Router);
    const navigate = jest.spyOn(router, 'navigateByUrl')
      .mockResolvedValue(true);
    set(summary({ completedCount: 20, averageScore: 97, perfectScores: 16 }));
    const button = root().querySelector('button.dp__link') as HTMLButtonElement;
    button.focus();
    expect(document.activeElement).toBe(button);
    button.click();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(router.serializeUrl(navigate.mock.calls[0][0] as UrlTree))
      .toBe('/progress');
  });
});
