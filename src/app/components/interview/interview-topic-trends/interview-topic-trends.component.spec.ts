import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import {
  InterviewAttemptHistoryEntry,
  InterviewTopicHistoryEntry,
  InterviewTopicTrendsResult
} from '@shared/models';
import { calculateTopicTrends } from '@shared/services/features/interview/interview-topic-trends.service';
import { InterviewTopicTrendsComponent } from './interview-topic-trends.component';

function tp(topicId: string, correct: number, total: number): InterviewTopicHistoryEntry {
  return {
    topicId,
    topicName: topicId,
    correct,
    total,
    percentage: Math.round((correct / total) * 100)
  };
}
function att(i: number, topics: InterviewTopicHistoryEntry[]): InterviewAttemptHistoryEntry {
  return {
    id: `a${i}`,
    attemptNumber: i + 1,
    completedAt: `2026-07-${String(10 + i).padStart(2, '0')}T10:00:00.000Z`,
    score: 50,
    totalQuestions: 10,
    percentage: 50,
    completionReason: 'submitted',
    selectedTopicIds: topics.map((t) => t.topicId),
    topicPerformance: topics
  };
}

// Signals: 50% → 60% improving, aggregate 55% (Needs Review); Router steady/strong.
const MULTI = calculateTopicTrends([
  att(0, [tp('Signals', 5, 10), tp('Router', 8, 10)]),
  att(1, [tp('Signals', 6, 10), tp('Router', 8, 10)])
]);
const SINGLE = calculateTopicTrends([att(0, [tp('Signals', 5, 10)])]);

describe('InterviewTopicTrendsComponent', () => {
  let fixture: ComponentFixture<InterviewTopicTrendsComponent>;

  function render(trends: InterviewTopicTrendsResult | null): HTMLElement {
    fixture = TestBed.createComponent(InterviewTopicTrendsComponent);
    fixture.componentRef.setInput('trends', trends);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  beforeEach(() =>
    TestBed.configureTestingModule({
      imports: [InterviewTopicTrendsComponent],
      providers: [provideRouter([])]
    })
  );

  it('renders nothing when trends is null', () => {
    expect(render(null).querySelector('.topic-trends')).toBeNull();
  });

  it('41/42/43/44. shows name, latest %, SEPARATE strength + direction, counts, change', () => {
    const el = render(MULTI);
    const signals = el.querySelector('.tt-card');
    expect(signals?.querySelector('.tt-card__name')?.textContent).toContain('Signals');
    const badges = Array.from(signals!.querySelectorAll('.tt-badge')).map((b) =>
      b.textContent?.trim()
    );
    expect(badges).toContain('Needs Review'); // strength band (weak → "Needs Review")
    expect(badges).toContain('Improving'); // direction, separate label
    expect(signals?.textContent).toContain('appearances and');
    expect(signals?.querySelector('.tt-up')?.textContent).toContain('+');
  });

  it('45. the sparkline chart is hidden from AT to avoid a duplicate readout', () => {
    const el = render(MULTI);
    expect(el.querySelector('.tt-spark')?.getAttribute('aria-hidden')).toBe('true');
    expect(el.querySelector('.tt-spark')?.getAttribute('aria-label')).toBeNull();
  });

  /**
   * CONFIRMED (manual Narrator Scan Mode report, 2026-10-19): entering a
   * card announced a full combined sentence (the former .tt-card__sr),
   * then Down Arrow read the heading, badges, and metrics a second time.
   * Fix: remove the combined sentence; each piece reads once, grouped
   * with its own label, via role="img" on the badges wrapper and
   * role="group" + a hidden-overlay span per metric row.
   */
  describe('each card reads once — no combined summary, no duplicate readout', () => {
    it('no longer renders a combined per-card summary sentence', () => {
      const el = render(MULTI);
      expect(el.querySelector('.tt-card__sr')).toBeNull();
    });

    it('strength + direction are one name on the existing badges wrapper (no new element)', () => {
      const el = render(MULTI);
      const badges = el.querySelector('.tt-card__badges') as HTMLElement;
      expect(badges.getAttribute('role')).toBe('img');
      expect(badges.getAttribute('aria-label')).toBe('Strength, Needs Review. Direction, Improving.');
      // Visible badge spans are untouched — still two real <span> elements.
      expect(badges.querySelectorAll('.tt-badge')).toHaveLength(2);
    });

    it('groups each metric row with its real, dynamic value', () => {
      const el = render(MULTI);
      const signalsCard = el.querySelector('.tt-card') as HTMLElement;
      const rows = signalsCard.querySelectorAll('.tt-card__metrics > div');
      expect(rows.length).toBe(4);
      rows.forEach((row) => expect(row.getAttribute('role')).toBe('group'));
      const phrase = (i: number) =>
        rows[i].querySelector('.visually-hidden-overlay')?.textContent?.trim();
      expect(phrase(0)).toBe('Latest, 60 percent');
      expect(phrase(1)).toBe('Previous, 50 percent'); // Signals: 50% -> 60%
      expect(phrase(2)).toBe('Change, up 10 points');
      expect(phrase(3)).toBe('Overall, 55 percent');
    });

    it('says "no previous attempt" rather than a number when there is none', () => {
      const el = render(SINGLE);
      const rows = el.querySelectorAll('.tt-card__metrics > div');
      expect(rows[1].querySelector('.visually-hidden-overlay')?.textContent?.trim()).toBe(
        'Previous, no previous attempt'
      );
    });

    it('hides the real metric dt/dd from the accessibility tree so nothing is spoken twice', () => {
      const el = render(MULTI);
      el.querySelectorAll('.tt-card__metrics dt, .tt-card__metrics dd').forEach((node) => {
        expect(node.getAttribute('aria-hidden')).toBe('true');
      });
    });

    it('does not change the visible metric text', () => {
      const el = render(MULTI);
      const rows = el.querySelectorAll('.tt-card__metrics > div');
      expect(rows[0].querySelector('dd')?.textContent?.trim()).toBe('60%');
    });

    it('introduces no new tabindex or live regions on the card', () => {
      const el = render(MULTI);
      el.querySelectorAll(
        '.tt-card [role="group"], .tt-card [role="img"], .tt-card .visually-hidden-overlay'
      ).forEach((node) => {
        expect(node.getAttribute('tabindex')).toBeNull();
        expect(node.getAttribute('aria-live')).toBeNull();
      });
    });
  });

  /**
   * CONFIRMED (manual Narrator Scan Mode report, 2026-10-19): right after
   * the Topic Trends heading, Down Arrow read each of these four stats'
   * label and value as two separate stops. Two earlier candidates fixed
   * the SPEECH grouping but not the HIGHLIGHT: a `role="group"` div with
   * a hidden `<span>` child shifted the highlight left of the label
   * (centering two different-width strings independently); moving the
   * phrase to the span's aria-label fixed the position but a manual
   * retest still showed TWO rectangles — confirmed via
   * Accessibility.getFullAXTree: `role="group"` does not suppress its
   * children, so the group AND its span child were both separately
   * exposed accessible objects. Current fix: role="img" + aria-label
   * directly on `dt` (no wrapping group, no hidden span) — the same
   * collapse-to-one-leaf technique already proven for the badges wrapper
   * and the score-hero/Readiness summary blocks. The wrapping `<div>` is
   * now unexposed (role=none/ignored) and dt's own box is unchanged
   * (confirmed via live measurement: same box as the original label),
   * so the one exposed object's bounds are the label's own, not the
   * value's or the whole tile's.
   */
  describe('the compact summary reads as one combined "Label, value" phrase per stat', () => {
    const dtFor = (el: HTMLElement, i: number): HTMLElement | null =>
      el.querySelectorAll<HTMLElement>('.tt-summary dt')[i] ?? null;

    it('groups each stat with its real, dynamic count, as one role="img" leaf on dt', () => {
      const el = render(MULTI);
      const rows = el.querySelectorAll('.tt-summary > div');
      expect(rows.length).toBe(4);
      expect(dtFor(el, 0)?.getAttribute('role')).toBe('img');
      expect(dtFor(el, 0)?.getAttribute('aria-label')).toBe('Topics Tracked, 2');
      expect(dtFor(el, 1)?.getAttribute('aria-label')).toBe('Improving, 1');
      expect(dtFor(el, 2)?.getAttribute('aria-label')).toBe('Holding Steady, 1');
      expect(dtFor(el, 3)?.getAttribute('aria-label')).toBe('Needs Attention, 1');
    });

    it('hides the real dd from the accessibility tree so the value is never a second stop; dt keeps its own visible text', () => {
      const el = render(MULTI);
      el.querySelectorAll('.tt-summary dd').forEach((node) => {
        expect(node.getAttribute('aria-hidden')).toBe('true');
      });
      expect(dtFor(el, 0)?.textContent?.trim()).toBe('Topics Tracked');
    });

    it('does not introduce a wrapping role="group" or a hidden overlay span', () => {
      const el = render(MULTI);
      expect(el.querySelector('.tt-summary [role="group"]')).toBeNull();
      expect(el.querySelector('.tt-summary .visually-hidden-overlay')).toBeNull();
    });

    it('does not change the visible stat text', () => {
      const el = render(MULTI);
      expect(el.querySelector('.tt-summary dd')?.textContent?.trim()).toBe('2'); // Topics Tracked
    });

    it('introduces no new tabindex or live regions on the grouped stats', () => {
      const el = render(MULTI);
      el.querySelectorAll('.tt-summary [role="img"]').forEach((node) => {
        expect(node.getAttribute('tabindex')).toBeNull();
        expect(node.getAttribute('aria-live')).toBeNull();
      });
    });
  });

  it('46/47. expands and collapses topic history with aria-expanded', () => {
    const el = render(MULTI);
    const toggle = el.querySelector('.tt-card__toggle') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(el.querySelector('.tt-history')).toBeNull();
    toggle.click();
    fixture.detectChanges();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const rows = el.querySelectorAll('.tt-history__table tbody tr');
    expect(rows.length).toBe(2);
    expect(el.querySelector('.tt-history__link')?.getAttribute('href')).toContain(
      '/interview/history/a'
    );
  });

  it('48. filter buttons expose aria-pressed and filter the list', () => {
    const el = render(MULTI);
    const filters = el.querySelectorAll<HTMLButtonElement>('.tt-filter');
    expect(filters[0].getAttribute('aria-pressed')).toBe('true'); // All active
    // Click "Improving" (index 1) → only Signals remains.
    filters[1].click();
    fixture.detectChanges();
    expect(el.querySelectorAll('.tt-card')).toHaveLength(1);
    expect(el.querySelector('.tt-card__name')?.textContent).toContain('Signals');
  });

  it('49. renders the limited-data (all insufficient) state', () => {
    const el = render(SINGLE);
    expect(el.querySelector('.topic-trends__note')?.textContent).toContain('repeated topics');
    expect(el.querySelector('.tt-badge--dir-insufficient')?.textContent).toContain(
      'More data needed'
    );
  });

  it('renders the no-topic-data state when history has no topic performance', () => {
    const el = render(calculateTopicTrends([att(0, [])]));
    expect(el.querySelector('.topic-trends__empty')?.textContent).toContain('not available');
  });

  it('50. does not force a fixed width (responsive: sparkline scales, table scrolls in-box)', () => {
    const el = render(MULTI);
    const svg = el.querySelector('.tt-spark') as SVGElement;
    expect(svg.getAttribute('viewBox')).toBe('0 0 120 36');
    expect(svg.getAttribute('width')).toBeNull();
  });
});
