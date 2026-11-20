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

    it('provides one complete summary before the separate Review Quiz button', () => {
      render(COMPLETE, {
        ...REVIEW,
        title: 'RxJS',
        difficulty: 'advanced',
        latestPercent: 20
      });
      const summary = root().querySelector('.rec__summary')!;
      const visible = summary.querySelector('[data-intro-visible]')!;
      const spoken = summary.querySelector('.intro-exposed-text')!;
      expect(spoken.textContent).toBe(
        'RxJS. Advanced. Latest score: 20%. ' +
        'Recommended based on your available quiz history.'
      );
      expect(spoken.childNodes).toHaveLength(1);
      expect(spoken.firstChild?.nodeType).toBe(Node.TEXT_NODE);
      expect(visible.getAttribute('aria-hidden')).toBe('true');
      expect(visible.contains(spoken)).toBe(false);
      expect(summary.contains(button())).toBe(false);
      expect(spoken.compareDocumentPosition(button()) &
        Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('updates the complete summary when the latest score changes', () => {
      for (const latestPercent of [0, 20, 100]) {
        render(COMPLETE, { ...REVIEW, latestPercent });
        const spoken = root().querySelector('.intro-exposed-text')!;
        expect(spoken.textContent).toContain(
          `Latest score: ${latestPercent}%.`
        );
        expect(spoken.childNodes).toHaveLength(1);
      }
    });

    it('omits an unavailable difficulty without an empty sentence', () => {
      render(COMPLETE, { ...REVIEW, difficulty: '' });
      expect(root().querySelector('.intro-exposed-text')?.textContent).toBe(
        'Pipes. Latest score: 40%. ' +
        'Recommended based on your available quiz history.'
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
