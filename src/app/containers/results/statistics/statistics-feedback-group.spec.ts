import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { of } from 'rxjs';

import { StatisticsComponent } from './statistics.component';
import { TopicQuizMetadataService } from '@shared/services/api/topic-quiz-metadata.service';
import { QuizService } from '@shared/services/data/quiz.service';
import { TimerService } from '@shared/services/features/timer/timer.service';
import { API_BASE_URL } from '@shared/tokens/api-base-url.token';

/**
 * The feedback image and the score sentence ("Try Again! You scored 2 out of 7
 * questions correctly.") are ONE Narrator group: the image and the sentence are
 * hidden from AT and the group exposes a single text node, built from the same
 * signals that render the visible sentence. (It was a role="img", which
 * Narrator spoke as "graphic".) With the resource links showing (low score in
 * the 'all' view) nothing is grouped, so the links stay reachable.
 */
const BASE = 'https://api.test/api';
const QUIZ_ID = 'router';

function build(correct: number, total: number, viewMode: 'score' | 'all' = 'score') {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [StatisticsComponent],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: API_BASE_URL, useValue: BASE },
      {
        provide: QuizService,
        useValue: {
          quizId: QUIZ_ID,
          totalQuestions: () => total,
          correctAnswersCountSig: signal(correct),
          getFinalResultSnapshot: () => null,
          patchFinalResultCompletionTime: () => undefined,
          setQuizStatus: () => undefined
        }
      },
      {
        provide: TimerService,
        useValue: {
          calculateTotalElapsedTime: () => 42,
          completionTime: 42,
          elapsedTimes: [10, 10, 10, 12],
          getDurableCompletionTime: () => 42,
          setDurableCompletionTime: () => undefined,
          isCountdown: () => false,
          timePerQuestion: 30
        }
      },
      {
        provide: TopicQuizMetadataService,
        useValue: { load: () => of([]), milestoneFor: (id: string) => id }
      }
    ]
  });
  const fixture = TestBed.createComponent(StatisticsComponent);
  fixture.componentRef.setInput('quizId', QUIZ_ID);
  fixture.componentRef.setInput('viewMode', viewMode);
  fixture.detectChanges();
  TestBed.tick();
  const http = TestBed.inject(HttpTestingController);
  http.match(() => true).forEach((r) => r.flush({ quizId: QUIZ_ID, resources: [] }));
  fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  return {
    fixture,
    root,
    group: () => root.querySelector('.score-feedback-group') as HTMLElement,
    exposed: () => root.querySelector('.score-feedback-group .intro-exposed-text') as HTMLElement | null,
    visibleSentence: () => (root.querySelector('.your-score')?.textContent ?? '').trim()
  };
}

describe('Results feedback image + score sentence — Narrator group', () => {
  it.each([
    [7, 7, 'Congratulations'],
    [5, 7, 'Not Bad'],
    [2, 7, 'Try Again']
  ])('%i of %i: a role="group" with one exposed text starting "%s!"', (correct, total, title) => {
    const t = build(correct, total);
    expect(t.group().getAttribute('role')).toBe('group');
    expect(t.group().hasAttribute('aria-label')).toBe(false);
    const exposed = t.exposed()!;
    expect(exposed.childNodes).toHaveLength(1);
    expect(exposed.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(exposed.textContent).toBe(
      `${title}!\nYou scored ${correct} out of ${total} questions correctly.`
    );
  });

  it('hides the image and the visible sentence from AT, so the image alt is not announced twice', () => {
    const t = build(2, 7);
    const visible = t.group().querySelector('[data-intro-visible]')!;
    expect(visible.getAttribute('aria-hidden')).toBe('true');
    expect(visible.querySelector('img')).not.toBeNull();
    expect(visible.querySelector('.your-score')).not.toBeNull();
    // The exposed text is outside the hidden wrapper.
    expect(t.exposed()!.closest('[aria-hidden="true"]')).toBeNull();
  });

  it('uses the same signal for the visible sentence and the exposed text', () => {
    const t = build(2, 7);
    const c = t.fixture.componentInstance;
    expect(t.visibleSentence()).toBe('You scored 2 out of 7 questions correctly.');
    expect(t.visibleSentence()).toBe(c.feedbackScoreText());
    expect(t.exposed()!.textContent).toBe(c.feedbackExposedText());
    expect(c.feedbackExposedText().split('\n')[1]).toBe(c.feedbackScoreText());
  });

  it('uses the singular "question" for a one-question quiz', () => {
    const t = build(1, 1);
    expect(t.visibleSentence()).toBe('You scored 1 out of 1 question correctly.');
    expect(t.exposed()!.textContent).toBe(
      'Congratulations!\nYou scored 1 out of 1 question correctly.'
    );
  });

  it('marks the score sentence as the width reference: as wide as the sentence, as tall as the image and sentence', () => {
    const t = build(2, 7);
    const ref = t.group().querySelector('[data-intro-width-ref]')!;
    expect(ref.classList.contains('your-score')).toBe(true);
    expect(ref.textContent?.trim()).toBe('You scored 2 out of 7 questions correctly.');
    // The reference sits inside the hidden visible wrapper, with the image.
    expect(t.group().querySelector('[data-intro-visible] [data-intro-width-ref]')).toBe(ref);
    // The COMPLETE text stays exposed: title, count and "correctly".
    expect(t.exposed()!.textContent).toBe('Try Again!\nYou scored 2 out of 7 questions correctly.');
  });

  it('the group is its own wrapper inside the column, so its box can be sized to the text', () => {
    const t = build(2, 7);
    const column = t.root.querySelector('.score-col-feedback')!;
    expect(column.hasAttribute('role')).toBe(false);
    expect(t.group().parentElement).toBe(column);
    // The directive sizes the group, so it is asked to.
    expect(t.group().querySelector('.intro-exposed-text')).not.toBeNull();
  });

  it('adds no Tab stop and nothing focusable', () => {
    const t = build(2, 7);
    expect(t.group().hasAttribute('tabindex')).toBe(false);
    expect(t.group().querySelectorAll('[tabindex], a, button, input')).toHaveLength(0);
  });

  it('low score in the "all" view (resource links showing) is NOT grouped, as before', () => {
    const t = build(2, 7, 'all');
    expect(t.group().hasAttribute('role')).toBe(false);
    expect(t.exposed()).toBeNull();
    const visible = t.group().querySelector('.score-feedback-visible')!;
    expect(visible.hasAttribute('aria-hidden')).toBe(false);
    expect(visible.hasAttribute('data-intro-visible')).toBe(false);
    // The sentence and the image stay available to AT in this state.
    expect(t.visibleSentence()).toBe('You scored 2 out of 7 questions correctly.');
  });

  it('a high score in the "all" view is still grouped (it shows no links)', () => {
    const t = build(7, 7, 'all');
    expect(t.group().getAttribute('role')).toBe('group');
    expect(t.exposed()).not.toBeNull();
  });
});
