import { ComponentFixture, TestBed } from '@angular/core/testing';

import { LearningPathState, ReviewRecommendation } from '@shared/models';
import { RecommendedNextQuizComponent } from './recommended-next-quiz.component';

const COMPLETE: LearningPathState = {
  recommendation: null,
  allComplete: true,
  totalCount: 20
};

const NEXT: LearningPathState = {
  recommendation: {
    quizId: 'templates',
    title: 'Templates',
    difficulty: 'beginner',
    reason: 'Build on your knowledge.',
    actionLabel: 'Start Quiz'
  },
  allComplete: false,
  totalCount: 20
};

const REVIEW: ReviewRecommendation = {
  quizId: 'pipes',
  title: 'Pipes',
  difficulty: 'beginner',
  latestPercent: 40,
  completedAt: '2026-10-01T10:00:00.000Z'
};

describe('RecommendedNextQuizComponent', () => {
  let fixture: ComponentFixture<RecommendedNextQuizComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [RecommendedNextQuizComponent] });
    fixture = TestBed.createComponent(RecommendedNextQuizComponent);
  });

  const root = (): HTMLElement => fixture.nativeElement;
  const text = (): string =>
    (root().textContent ?? '').replace(/\s+/g, ' ').trim();
  const button = (): HTMLButtonElement =>
    root().querySelector('button') as HTMLButtonElement;
  const render = (
    state: LearningPathState,
    review?: ReviewRecommendation | null
  ) => {
    fixture.componentRef.setInput('state', state);
    if (review !== undefined) fixture.componentRef.setInput('review', review);
    fixture.detectChanges();
  };

  describe('review mode', () => {
    beforeEach(() => render(COMPLETE, REVIEW));

    it('shows title, difficulty, latest score and the explanation', () => {
      expect(root().querySelector('h3')?.textContent).toContain('Pipes');
      expect(text()).toContain('Beginner');
      expect(text()).toContain('Latest score: 40%');
      expect(text()).toContain(
        'Recommended based on your available quiz history.'
      );
    });

    it('offers "Review Quiz" with a name that includes the quiz', () => {
      expect(button().textContent?.trim()).toBe('Review Quiz');
      expect(button().getAttribute('aria-label')).toBe(
        'Review quiz: Pipes'
      );
      expect(button().type).toBe('button');
    });

    it('emits the quiz id and never promises Continue or Retake', () => {
      const emitted: string[] = [];
      fixture.componentInstance.reviewQuiz.subscribe((id) => emitted.push(id));
      button().click();
      expect(emitted).toEqual(['pipes']);
      expect(text()).not.toMatch(/continue|retake|restart/i);
    });

    it('has one button only (no Build an Interview here)', () => {
      expect(root().querySelectorAll('button')).toHaveLength(1);
    });

    it('keeps the score as readable text (not colour or an icon)', () => {
      const score = root().querySelector('.rec__score');
      expect(score?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
        'Latest score: 40%'
      );
    });
  });

  it('without a review it still renders the Learning Path Complete card', () => {
    render(COMPLETE, null);
    expect(text()).toContain('Learning Path Complete');
    expect(text()).toContain('all 20 topic quizzes');
    expect(button().getAttribute('aria-label')).toBe('Build an interview');
    const emitted: string[] = [];
    fixture.componentInstance.buildInterview.subscribe(() => emitted.push('b'));
    button().click();
    expect(emitted).toEqual(['b']);
  });

  it('without a review it still renders the next-quiz recommendation', () => {
    render(NEXT);
    expect(text()).toContain('Recommended Next Quiz');
    expect(text()).toContain('Templates');
    expect(button().textContent?.trim()).toBe('Start Quiz');
    expect(text()).not.toContain('Latest score');
  });
});
