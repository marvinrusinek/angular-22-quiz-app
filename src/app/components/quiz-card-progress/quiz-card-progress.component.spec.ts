import { ComponentFixture, TestBed } from '@angular/core/testing';

import { QuizCardProgressComponent, QuizCardProgressState } from './quiz-card-progress.component';

describe('QuizCardProgressComponent', () => {
  let fixture: ComponentFixture<QuizCardProgressComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [QuizCardProgressComponent] });
    fixture = TestBed.createComponent(QuizCardProgressComponent);
  });

  const set = (state: QuizCardProgressState, bestScore: number | null = null): void => {
    fixture.componentRef.setInput('state', state);
    fixture.componentRef.setInput('bestScore', bestScore);
    fixture.detectChanges();
  };
  const text = (): string => (fixture.nativeElement.textContent ?? '').replace(/\s+/g, ' ').trim();

  it('shows "Not Started"', () => {
    set('not-started');
    expect(text()).toContain('Not Started');
  });

  it('shows "In Progress"', () => {
    set('in-progress');
    expect(text()).toContain('In Progress');
  });

  it('shows "Completed" with the best score', () => {
    set('completed', 80);
    expect(text()).toContain('Completed');
    expect(text()).toContain('80%');
  });

  it('shows "Completed" without a score when best score is null', () => {
    set('completed', null);
    expect(text()).toContain('Completed');
    expect(text()).not.toContain('%');
  });

  it('does not show a best score in non-completed states', () => {
    set('in-progress', 90); // score ignored unless completed
    expect(text()).not.toContain('90');
  });
});
