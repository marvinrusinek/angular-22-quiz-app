import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

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
  const values = (): string[] =>
    Array.from(root().querySelectorAll('.dp__value')).map((e) => e.textContent?.trim() ?? '');
  const spoken = (): string[] =>
    Array.from(root().querySelectorAll('.dp__sr')).map((e) => e.textContent?.trim() ?? '');

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

  it('speaks one real-text phrase per stat and hides the visual copy', () => {
    set(summary({ completedCount: 12, averageScore: 78, perfectScores: 5 }));
    const s = spoken();
    expect(s).toHaveLength(3);
    expect(s[0]).toContain('12');
    expect(s[0]).toContain('20');
    expect(s[1]).toContain('78');
    expect(s[2]).toContain('5');
    root()
      .querySelectorAll('.dp__text')
      .forEach((t) => expect(t.getAttribute('aria-hidden')).toBe('true'));
  });

  it('is a labelled region with an h2 and a link to /progress', () => {
    set(summary());
    const region = root().querySelector('section')!;
    const heading = root().querySelector('h2')!;
    expect(region.getAttribute('aria-labelledby')).toBe(heading.id);
    expect(heading.textContent).toContain('Your Progress');
    expect(root().querySelector('a.dp__link')?.getAttribute('href')).toBe('/progress');
  });
});
