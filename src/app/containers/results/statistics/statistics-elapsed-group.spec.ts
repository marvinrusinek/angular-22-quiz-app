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
 * The clock icon and the elapsed-time sentence ("Completed in 0 minutes and 2
 * seconds.") are ONE Narrator group: both are hidden from AT and the group
 * exposes a single text node built from the same signal that renders the
 * visible sentence. (It was a role="img", which Narrator spoke as "graphic".)
 */
const BASE = 'https://api.test/api';
const QUIZ_ID = 'router';

function build(seconds: number) {
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
          totalQuestions: () => 7,
          correctAnswersCountSig: signal(2),
          getFinalResultSnapshot: () => null,
          patchFinalResultCompletionTime: () => undefined,
          setQuizStatus: () => undefined
        }
      },
      {
        provide: TimerService,
        useValue: {
          calculateTotalElapsedTime: () => seconds,
          completionTime: seconds,
          elapsedTimes: [seconds],
          getDurableCompletionTime: () => seconds,
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
  // 'score' view: a low score in the 'all' view shows resource links, which are never grouped.
  fixture.componentRef.setInput('viewMode', 'score');
  fixture.detectChanges();
  TestBed.tick();
  TestBed.inject(HttpTestingController)
    .match(() => true)
    .forEach((r) => r.flush({ quizId: QUIZ_ID, resources: [] }));
  fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  return {
    fixture,
    root,
    section: () => root.querySelector('.time-section') as HTMLElement,
    group: () => root.querySelector('.time-group') as HTMLElement,
    exposed: () => root.querySelector('.time-group .intro-exposed-text') as HTMLElement,
    visibleSentence: () => (root.querySelector('.elapsed-time')?.textContent ?? '').trim()
  };
}

describe('Results elapsed time — Narrator group', () => {
  it('is a role="group" inside the unchanged time section, not a graphic', () => {
    const t = build(2);
    expect(t.group().getAttribute('role')).toBe('group');
    expect(t.group().hasAttribute('aria-label')).toBe(false);
    expect(t.section().hasAttribute('role')).toBe(false);
    expect(t.group().parentElement).toBe(t.section());
  });

  it('keeps the clock and the sentence together, hidden from AT as one unit', () => {
    const t = build(2);
    const visible = t.group().querySelector('[data-intro-visible]')!;
    expect(visible.getAttribute('aria-hidden')).toBe('true');
    expect(visible.querySelector('.time-icon')?.textContent?.trim()).toBe('⏱️');
    expect(visible.querySelector('.elapsed-time')).not.toBeNull();
    expect(t.exposed().closest('[aria-hidden="true"]')).toBeNull();
  });

  it('exposes exactly ONE text node: the sentence only, with no clock, no "Timer." prefix and no blank-line padding', () => {
    const t = build(2);
    expect(t.exposed().childNodes).toHaveLength(1);
    expect(t.exposed().firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(t.exposed().textContent).toBe('Completed in 0 minutes and 2 seconds.');
    expect(t.exposed().textContent).not.toContain('⏱');
    expect(t.exposed().textContent).not.toMatch(/timer|clock|stopwatch/i);
    expect(t.exposed().textContent).not.toMatch(/[ \n]/);
    expect(t.exposed().textContent!.startsWith('Completed in')).toBe(true);
  });

  it('shares ONE signal between the visible sentence and the exposed text', () => {
    const t = build(2);
    const c = t.fixture.componentInstance;
    expect(t.visibleSentence()).toBe(c.elapsedText());
    expect(t.exposed().textContent).toBe(c.elapsedText());
  });

  // Minutes and seconds each pluralise on their own: "1 minute" / "1 second",
  // otherwise "N minutes" / "N seconds" (including "0 minutes" and "0 seconds").
  it.each([
    [0, 'Completed in 0 minutes and 0 seconds.'],
    [1, 'Completed in 0 minutes and 1 second.'],
    [2, 'Completed in 0 minutes and 2 seconds.'],
    [59, 'Completed in 0 minutes and 59 seconds.'],
    [60, 'Completed in 1 minute and 0 seconds.'],
    [61, 'Completed in 1 minute and 1 second.'],
    [62, 'Completed in 1 minute and 2 seconds.'],
    [119, 'Completed in 1 minute and 59 seconds.'],
    [120, 'Completed in 2 minutes and 0 seconds.'],
    [121, 'Completed in 2 minutes and 1 second.'],
    [125, 'Completed in 2 minutes and 5 seconds.'],
    [3600, 'Completed in 60 minutes and 0 seconds.']
  ])('%i s reads "%s" (visible and exposed alike)', (seconds, expected) => {
    const t = build(seconds);
    expect(t.visibleSentence()).toBe(expected);
    expect(t.exposed().textContent).toBe(expected);
  });

  it('follows the duration when it changes', () => {
    const t = build(2);
    t.fixture.componentInstance.completionTimeSig.set(185);
    t.fixture.detectChanges();
    TestBed.tick();
    expect(t.visibleSentence()).toBe('Completed in 3 minutes and 5 seconds.');
    expect(t.exposed().textContent).toBe('Completed in 3 minutes and 5 seconds.');
    expect(t.exposed().childNodes).toHaveLength(1);
    t.fixture.componentInstance.completionTimeSig.set(181);
    t.fixture.detectChanges();
    TestBed.tick();
    expect(t.exposed().textContent).toBe('Completed in 3 minutes and 1 second.');
  });

  it('adds no Tab stop and nothing focusable', () => {
    const t = build(2);
    expect(t.group().hasAttribute('tabindex')).toBe(false);
    expect(t.group().querySelectorAll('[tabindex], a, button, input')).toHaveLength(0);
  });

  it('leaves the feedback and breakdown groups as they were', () => {
    const t = build(2);
    expect(t.root.querySelector('.score-feedback-group')?.getAttribute('role')).toBe('group');
    expect(t.root.querySelector('.score-breakdown')?.getAttribute('role')).toBe('group');
  });
});
