import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';

import { ProgressPanelComponent } from './progress-panel.component';
import { ProgressSummary } from '../../shared/models/progress.model';
import { TopicPerformanceHistoryService } from '../../shared/services/progress/topic-performance-history.service';
import { QuizCardProgressState } from '../quiz-card-progress/quiz-card-progress.component';

function summary(overrides: Partial<ProgressSummary> = {}): ProgressSummary {
  return {
    completedCount: 3,
    totalCount: 15,
    completionPercentage: 20,
    byDifficulty: [
      { difficulty: 'beginner', completed: 2, total: 4 },
      { difficulty: 'intermediate', completed: 1, total: 6 }
    ],
    strongestQuiz: { quizId: 'di', milestone: 'Dependency Injection', bestScore: 100 },
    weakestQuiz: { quizId: 'rx', milestone: 'RxJS', bestScore: 60 },
    averageScore: 80,
    perfectScores: 1,
    questionsCompleted: 30,
    ...overrides
  };
}

describe('ProgressPanelComponent', () => {
  let fixture: ComponentFixture<ProgressPanelComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ProgressPanelComponent, NoopAnimationsModule]
    });
    fixture = TestBed.createComponent(ProgressPanelComponent);
  });

  const set = (states: QuizCardProgressState[], s: ProgressSummary | null = summary()): void => {
    fixture.componentRef.setInput('cardStates', states);
    fixture.componentRef.setInput('summary', s);
    fixture.detectChanges();
  };
  const panel = (): HTMLElement | null => fixture.nativeElement.querySelector('mat-expansion-panel');
  const header = (): HTMLElement | null => fixture.nativeElement.querySelector('mat-expansion-panel-header');
  const details = (): HTMLElement | null => fixture.nativeElement.querySelector('.progress-summary');

  // 1
  it('is hidden when no quiz has been started or completed', () => {
    set(['not-started', 'not-started', 'not-started']);
    expect(panel()).toBeNull();
  });

  // 2
  it('appears when at least one quiz is In Progress', () => {
    set(['not-started', 'in-progress', 'not-started']);
    expect(panel()).toBeTruthy();
  });

  // 3
  it('appears when at least one quiz is Completed', () => {
    set(['completed', 'not-started']);
    expect(panel()).toBeTruthy();
  });

  // 4
  it('is collapsed by default', () => {
    set(['completed']);
    // The Material header carries aria-expanded="false" until toggled.
    const button = header()?.querySelector('[role="button"]') ?? header();
    expect(button?.getAttribute('aria-expanded')).toBe('false');
  });

  // 5
  it('header shows the completed count and percentage', () => {
    set(['completed'], summary({ completedCount: 3, totalCount: 15, completionPercentage: 20 }));
    const text = (header()?.textContent ?? '').replace(/\s+/g, ' ').trim();
    expect(text).toContain('Your Progress');
    expect(text).toContain('3 of 15 completed');
    expect(text).toContain('20%');
  });

  // 6
  it('reveals the detailed breakdown after expanding', () => {
    set(['completed']);
    header()?.click();
    fixture.detectChanges();
    const text = (details()?.textContent ?? '').replace(/\s+/g, ' ').trim();
    expect(text).toContain('Overall Progress');        // overall bar
    expect(text).toContain('Beginner');                // difficulty bar
    expect(text).toContain('Dependency Injection');    // strongest
    // Needs Review no longer echoes the best-score weakest quiz; with no
    // reliable topic-performance data it shows the insufficient-data message.
    expect(text).toContain('Complete a quiz or interview to identify weak areas.');
  });

  it('does not render for a null summary even with activity', () => {
    set(['completed'], null);
    expect(panel()).toBeNull();
  });

  describe('Performance Insights inside the panel', () => {
    afterEach(() => localStorage.clear());

    const insights = (): HTMLElement | null =>
      fixture.nativeElement.querySelector('codelab-performance-insights');
    const text = (n: Element | null): string => (n?.textContent ?? '').replace(/\s+/g, ' ').trim();

    it('sits BENEATH the existing progress breakdown, which is unchanged', () => {
      set(['completed']);
      header()?.click();
      fixture.detectChanges();

      expect(insights()).toBeTruthy();
      // DOCUMENT_POSITION_FOLLOWING: insights come after the progress summary.
      expect(details()!.compareDocumentPosition(insights()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      // Existing content is all still there.
      expect(text(details())).toContain('Overall Progress');
      expect(text(details())).toContain('Dependency Injection');
      expect(text(details())).toContain('Complete a quiz or interview to identify weak areas.');
    });

    it('shows the neutral empty state when there is no performance history yet', () => {
      set(['in-progress']);
      expect(text(insights())).toContain('Performance Insights');
      expect(text(insights())).toContain('Complete quizzes or interviews to build your performance history.');
    });

    it('reflects recorded history, live, without touching the progress summary', () => {
      set(['completed']);
      TestBed.inject(TopicPerformanceHistoryService).record('quiz:rxjs:1', 'topic-quiz', [
        { topicId: 'rxjs', topicName: 'RxJS', correct: 9, total: 10 }
      ]);
      fixture.detectChanges();

      expect(text(insights())).toContain('Topic Quiz');
      expect(text(insights())).toContain('90%');
      expect(text(insights())).toContain('9 / 10 questions · 1 attempt');
      expect(text(insights())).not.toContain('Interview Mode');
      expect(text(details())).toContain('Overall Progress');
    });

    it('does not make the panel appear when there is no activity, whatever the history holds', () => {
      TestBed.inject(TopicPerformanceHistoryService).record('quiz:rxjs:1', 'topic-quiz', [
        { topicId: 'rxjs', topicName: 'RxJS', correct: 9, total: 10 }
      ]);
      set(['not-started', 'not-started']);
      expect(panel()).toBeNull();
      expect(insights()).toBeNull();
    });
  });
});
