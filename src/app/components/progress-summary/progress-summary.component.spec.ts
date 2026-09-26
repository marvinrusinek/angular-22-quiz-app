import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ProgressSummaryComponent } from './progress-summary.component';
import { ProgressSummary } from '@shared/models';

function summary(overrides: Partial<ProgressSummary> = {}): ProgressSummary {
  return {
    completedCount: 0,
    totalCount: 5,
    completionPercentage: 0,
    byDifficulty: [],
    strongestQuiz: null,
    weakestQuiz: null,
    averageScore: 0,
    perfectScores: 0,
    questionsCompleted: 0,
    ...overrides
  };
}

describe('ProgressSummaryComponent', () => {
  let fixture: ComponentFixture<ProgressSummaryComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [ProgressSummaryComponent] });
    fixture = TestBed.createComponent(ProgressSummaryComponent);
  });

  const set = (s: ProgressSummary | null): void => {
    fixture.componentRef.setInput('summary', s);
    fixture.detectChanges();
  };
  const root = (): HTMLElement | null => fixture.nativeElement.querySelector('.progress-summary');
  const text = (): string => (root()?.textContent ?? '').replace(/\s+/g, ' ').trim();

  it('renders nothing when there are no quizzes', () => {
    set(summary({ totalCount: 0 }));
    expect(root()).toBeNull();
  });

  it('renders nothing for a null summary', () => {
    set(null);
    expect(root()).toBeNull();
  });

  it('shows completed count and 0% with no completed quizzes', () => {
    set(summary({ completedCount: 0, totalCount: 5, completionPercentage: 0 }));
    expect(text()).toContain('0 / 5');
    expect(text()).toContain('0%');
    // Percentage available as text, not color-only.
    const bar = fixture.nativeElement.querySelector('.progress-summary__bar[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuenow')).toBe('0');
  });

  it('shows partial completion with difficulty rows', () => {
    set(summary({
      completedCount: 3,
      totalCount: 5,
      completionPercentage: 60,
      byDifficulty: [
        { difficulty: 'beginner', completed: 2, total: 2 },
        { difficulty: 'intermediate', completed: 1, total: 2 }
      ],
      strongestQuiz: { quizId: 'b1', milestone: 'Dependency Injection', bestScore: 100 }
    }));
    expect(text()).toContain('3 / 5');
    expect(text()).toContain('60%');
    expect(text()).toContain('Beginner');
    expect(text()).toContain('2 / 2');
    expect(text()).toContain('Dependency Injection');
  });

  // Needs Review is now driven by WeakAreasService, not the best-score
  // percentage. With no reliable topic-performance data it shows the
  // insufficient-data message rather than hiding.
  it('shows strongest, and the insufficient-data message under Needs Review', () => {
    set(summary({
      completedCount: 1,
      completionPercentage: 20,
      strongestQuiz: { quizId: 'b1', milestone: 'RxJS', bestScore: 60 },
      weakestQuiz: null
    }));
    expect(text()).toContain('Strongest');
    expect(text()).toContain('RxJS');
    expect(text()).toContain('Needs Review');
    expect(text()).toContain('Complete a quiz or interview to identify weak areas.');
    expect(text()).not.toContain('Practice Weak Areas');   // no action without weak topics
  });

  it('shows both strongest and needs-review when both present', () => {
    set(summary({
      completedCount: 2,
      completionPercentage: 40,
      strongestQuiz: { quizId: 'a1', milestone: 'DI', bestScore: 100 },
      weakestQuiz: { quizId: 'r1', milestone: 'RxJS', bestScore: 55 }
    }));
    expect(text()).toContain('Strongest');
    expect(text()).toContain('Needs Review');
    // The old best-score weakness (55%) is deliberately NOT used here any more.
    expect(text()).not.toContain('55%');
    expect(text()).toContain('Complete a quiz or interview to identify weak areas.');
  });

  it('renders 100% at full completion', () => {
    set(summary({ completedCount: 5, totalCount: 5, completionPercentage: 100 }));
    expect(text()).toContain('5 / 5');
    expect(text()).toContain('100%');
  });

  it('renders the Average Score / Perfect Scores / Questions Completed stats', () => {
    set(summary({ completedCount: 3, averageScore: 82, perfectScores: 1, questionsCompleted: 30 }));
    const labels = Array.from(
      fixture.nativeElement.querySelectorAll('.progress-summary__stat-label')
    ).map((el) => (el as HTMLElement).textContent!.trim());
    const values = Array.from(
      fixture.nativeElement.querySelectorAll('.progress-summary__stat-value')
    ).map((el) => (el as HTMLElement).textContent!.trim());
    expect(labels).toEqual(['Average Score', 'Perfect Scores', 'Questions Completed']);
    expect(values).toEqual(['82%', '1', '30']);
  });

  it('shows 0 metrics when nothing is completed (no NaN / negatives)', () => {
    set(summary({ completedCount: 0, averageScore: 0, perfectScores: 0, questionsCompleted: 0 }));
    const values = Array.from(
      fixture.nativeElement.querySelectorAll('.progress-summary__stat-value')
    ).map((el) => (el as HTMLElement).textContent!.trim());
    expect(values).toEqual(['0%', '0', '0']);
  });

  describe('details variant', () => {
    const setDetails = (s: ProgressSummary): void => {
      fixture.componentRef.setInput('summary', s);
      fixture.componentRef.setInput('variant', 'details');
      fixture.detectChanges();
    };

    it('renders the full bar-graph breakdown (overall + difficulty + highlights) without the header-owned heading/Completed row', () => {
      setDetails(summary({
        completedCount: 3,
        totalCount: 5,
        completionPercentage: 60,
        byDifficulty: [{ difficulty: 'beginner', completed: 2, total: 2 }],
        strongestQuiz: { quizId: 'b1', milestone: 'Dependency Injection', bestScore: 100 },
        weakestQuiz: { quizId: 'r1', milestone: 'RxJS', bestScore: 40 }
      }));
      // Bar-graph detail content present, including the overall progress bar:
      expect(text()).toContain('Overall Progress');
      expect(text()).toContain('60%');
      expect(text()).toContain('Beginner');
      expect(text()).toContain('Dependency Injection');
      // Needs Review is WeakAreasService-driven now, so the best-score weakest
      // quiz (RxJS 40%) is no longer echoed here.
      expect(text()).toContain('Needs Review');
      expect(text()).not.toContain('RxJS');
      // A progress bar element with accessible attributes is rendered.
      const bar = fixture.nativeElement.querySelector('.progress-summary__bar[role="progressbar"]');
      expect(bar?.getAttribute('aria-valuenow')).toBe('60');
      // Header-owned pieces stay out of the body: no heading, no "Completed X / Y"
      // row. Check the row LABEL specifically (the stats use a different class),
      // so the "Questions Completed" stat doesn't false-positive here.
      expect(fixture.nativeElement.querySelector('.progress-summary__heading')).toBeNull();
      const rowLabels = Array.from(
        fixture.nativeElement.querySelectorAll('.progress-summary__label')
      ).map((el) => (el as HTMLElement).textContent!.trim());
      expect(rowLabels).not.toContain('Completed');
    });
  });
});
