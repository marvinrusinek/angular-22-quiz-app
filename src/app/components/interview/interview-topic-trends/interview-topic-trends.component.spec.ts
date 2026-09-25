import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { InterviewAttemptHistoryEntry, InterviewTopicHistoryEntry } from '@shared/models/interview-history.model';
import { InterviewTopicTrendsResult } from '@shared/models/interview-topic-trends.model';
import { calculateTopicTrends } from '@shared/services/features/interview/interview-topic-trends.service';
import { InterviewTopicTrendsComponent } from './interview-topic-trends.component';

function tp(topicId: string, correct: number, total: number): InterviewTopicHistoryEntry {
  return { topicId, topicName: topicId, correct, total, percentage: Math.round((correct / total) * 100) };
}
function att(i: number, topics: InterviewTopicHistoryEntry[]): InterviewAttemptHistoryEntry {
  return {
    id: `a${i}`, attemptNumber: i + 1, completedAt: `2026-07-${String(10 + i).padStart(2, '0')}T10:00:00.000Z`,
    score: 50, totalQuestions: 10, percentage: 50, completionReason: 'submitted',
    selectedTopicIds: topics.map((t) => t.topicId), topicPerformance: topics
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

  beforeEach(() => TestBed.configureTestingModule({
    imports: [InterviewTopicTrendsComponent],
    providers: [provideRouter([])]
  }));

  it('renders nothing when trends is null', () => {
    expect(render(null).querySelector('.topic-trends')).toBeNull();
  });

  it('41/42/43/44. shows name, latest %, SEPARATE strength + direction, counts, change', () => {
    const el = render(MULTI);
    const signals = el.querySelector('.tt-card');
    expect(signals?.querySelector('.tt-card__name')?.textContent).toContain('Signals');
    const badges = Array.from(signals!.querySelectorAll('.tt-badge')).map((b) => b.textContent?.trim());
    expect(badges).toContain('Needs Review');   // strength band (weak → "Needs Review")
    expect(badges).toContain('Improving');       // direction, separate label
    expect(signals?.textContent).toContain('appearances and');
    expect(signals?.querySelector('.tt-up')?.textContent).toContain('+');
  });

  it('45. provides an accessible summary (strength + direction + scores); chart itself is hidden', () => {
    const el = render(MULTI);
    const sr = el.querySelector('.tt-card__sr')?.textContent ?? '';
    expect(sr).toContain('Needs Review');       // strength announced
    expect(sr).toContain('improving');           // direction announced
    expect(sr).toContain('latest score');
    // The sparkline is decorative — hidden from AT to avoid a duplicate readout.
    expect(el.querySelector('.tt-spark')?.getAttribute('aria-hidden')).toBe('true');
    expect(el.querySelector('.tt-spark')?.getAttribute('aria-label')).toBeNull();
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
    expect(el.querySelector('.tt-history__link')?.getAttribute('href')).toContain('/interview/history/a');
  });

  it('48. filter buttons expose aria-pressed and filter the list', () => {
    const el = render(MULTI);
    const filters = el.querySelectorAll<HTMLButtonElement>('.tt-filter');
    expect(filters[0].getAttribute('aria-pressed')).toBe('true');   // All active
    // Click "Improving" (index 1) → only Signals remains.
    filters[1].click();
    fixture.detectChanges();
    expect(el.querySelectorAll('.tt-card')).toHaveLength(1);
    expect(el.querySelector('.tt-card__name')?.textContent).toContain('Signals');
  });

  it('49. renders the limited-data (all insufficient) state', () => {
    const el = render(SINGLE);
    expect(el.querySelector('.topic-trends__note')?.textContent).toContain('repeated topics');
    expect(el.querySelector('.tt-badge--dir-insufficient')?.textContent).toContain('More data needed');
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
