import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';

import { ProgressPageComponent } from './progress-page.component';
import { InterviewResult } from '@shared/models';
import { API_BASE_URL } from '@shared/tokens/api-base-url.token';
import { InterviewHistoryService } from '@shared/services/features/interview/interview-history.service';
import { SessionEngagementService } from '@shared/services/state/session-engagement.service';
import { TopicPerformanceHistoryService } from '@shared/services/progress/topic-performance-history.service';

const API = 'http://test/api';

function interviewResult(pct: number, over: Partial<InterviewResult> = {}): InterviewResult {
  return {
    total: 10, answered: 10, unanswered: 0, correct: pct / 10, incorrect: 10 - pct / 10,
    percentage: pct, timeUsedSeconds: 120, timeRemainingSeconds: 0, difficulty: 'mixed',
    topicIds: ['router'],
    perTopic: [{ quizId: 'router', title: 'Angular Router', correct: pct / 10, total: 10, percentage: pct }],
    submittedByExpiry: false, focusChanges: 0,
    ...over
  };
}

describe('ProgressPageComponent', () => {
  let el: HTMLElement;
  let component: ProgressPageComponent;
  let http: HttpTestingController;

  /**
   * `seed` runs BEFORE the component exists, through the live singleton
   * services — the histories read localStorage once when first constructed, so
   * seeding raw storage afterwards would silently seed nothing.
   */
  function create(seed?: () => void): void {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [ProgressPageComponent],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: API }
      ]
    });
    seed?.();
    const fixture = TestBed.createComponent(ProgressPageComponent);
    component = fixture.componentInstance;
    el = fixture.nativeElement as HTMLElement;
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
  }

  const q = (sel: string): HTMLElement | null => el.querySelector<HTMLElement>(sel);
  const qa = (sel: string): HTMLElement[] => Array.from(el.querySelectorAll<HTMLElement>(sel));
  const text = (n: Element | null): string => (n?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const link = (label: string): HTMLAnchorElement | undefined =>
    qa('a').find((a) => text(a) === label) as HTMLAnchorElement | undefined;

  const seedBestScore = (): void =>
    localStorage.setItem('quizBestScores', JSON.stringify({ typescript: 80 }));
  const seedTopicQuiz = (): void =>
    TestBed.inject(TopicPerformanceHistoryService).record('quiz:rxjs:1', 'topic-quiz', [
      { topicId: 'rxjs', topicName: 'RxJS', correct: 9, total: 10 }
    ]);
  const seedInterview = (over: Partial<InterviewResult> = {}): void =>
    TestBed.inject(InterviewHistoryService).record(interviewResult(70, over));
  const seedPractice = (): void =>
    TestBed.inject(TopicPerformanceHistoryService).record('practice:p1', 'weak-areas-practice', [
      { topicId: 'signals', topicName: 'Signals', correct: 2, total: 4 }
    ]);

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  // ── new user ──────────────────────────────────────────────────────

  describe('a brand-new user (no progress of any kind)', () => {
    beforeEach(() => create());

    it('renders a page — never a redirect, error or blank screen', () => {
      expect(q('.progress-page')).not.toBeNull();
      expect(text(q('h1'))).toBe('Your Progress');
    });

    it('shows a useful, accessible empty state', () => {
      const empty = q('.progress-page__empty')!;
      expect(empty.getAttribute('role')).toBe('status');
      expect(text(empty)).toBe('Complete a Topic Quiz or an Interview to start building your performance history.');
    });

    it('offers "Choose a Quiz" and "Start an Interview" as real links', () => {
      expect(link('Choose a Quiz')!.getAttribute('href')).toBe('/quiz');
      expect(link('Start an Interview')!.getAttribute('href')).toBe('/interview');
      expect(link('Choose a Quiz')!.classList).toContain('pp-btn--primary');
    });

    it('fabricates no dashboard: no summary, no insights', () => {
      expect(q('codelab-progress-summary')).toBeNull();
      expect(q('codelab-performance-insights')).toBeNull();
    });

    it('is not an accordion — the retired panel wrapper is gone', () => {
      expect(q('mat-expansion-panel')).toBeNull();
      expect(q('mat-accordion')).toBeNull();
    });

    it('writes no storage of its own, marks no engagement, creates no session', () => {
      // ThemeService legitimately persists the theme (the toggle is on the page).
      const keys = (s: Storage): string[] => Object.keys(s).filter((k) => k !== 'quiz-app-theme');
      expect(keys(localStorage)).toEqual([]);
      expect(keys(sessionStorage)).toEqual([]);
      expect(TestBed.inject(SessionEngagementService).engaged()).toBe(false);
    });

    it('hasProgress is false', () => {
      expect(component.hasProgress()).toBe(false);
    });
  });

  // ── each source alone ─────────────────────────────────────────────

  describe('Topic Quiz history only', () => {
    beforeEach(() => create(seedTopicQuiz));

    it('shows the dashboard, with the Topic Quiz performance and nothing fabricated', () => {
      expect(q('.progress-page__empty')).toBeNull();
      expect(q('codelab-progress-summary')).not.toBeNull();
      const insights = text(q('codelab-performance-insights'));
      expect(insights).toContain('Topic Quiz');
      expect(insights).toContain('90%');
      expect(insights).toContain('9 / 10 questions · 1 attempt');
      expect(insights).not.toContain('Interview Mode');
      expect(insights).not.toContain('Weak Areas Practice');
    });

    it('switches the links to secondary style once there is progress', () => {
      expect(link('Choose a Quiz')!.classList).not.toContain('pp-btn--primary');
    });
  });

  describe('Custom Interview history only', () => {
    beforeEach(() => create(() => seedInterview()));

    it('shows Your Progress with the Interview performance — no Topic Quiz required', () => {
      expect(q('.progress-page__empty')).toBeNull();
      const insights = text(q('codelab-performance-insights'));
      expect(insights).toContain('Interview Mode');
      expect(insights).toContain('70%');
      expect(insights).toContain('7 / 10 questions · 1 attempt');
      expect(insights).not.toContain('Topic Quiz');
    });

    it('links on to the existing Interview History', () => {
      expect(q('codelab-performance-insights a[href="/interview/history"]')).not.toBeNull();
    });
  });

  describe('Preset Interview history only', () => {
    beforeEach(() => create(() => seedInterview({ presetId: 'junior', presetName: 'Junior Angular Developer' })));

    it('behaves exactly like a custom Interview: dashboard with Interview performance', () => {
      expect(q('.progress-page__empty')).toBeNull();
      const insights = text(q('codelab-performance-insights'));
      expect(insights).toContain('Interview Mode');
      expect(insights).toContain('7 / 10 questions · 1 attempt');
    });
  });

  describe('Weak Areas Practice history only', () => {
    beforeEach(() => create(seedPractice));

    it('shows the Practice performance, labelled as Practice', () => {
      expect(q('.progress-page__empty')).toBeNull();
      const insights = text(q('codelab-performance-insights'));
      expect(insights).toContain('Weak Areas Practice');
      expect(insights).toContain('2 / 4 questions · 1 attempt');
      expect(insights).not.toContain('Topic Quiz 5');
    });
  });

  // ── mixed ─────────────────────────────────────────────────────────

  describe('mixed history', () => {
    beforeEach(() => create(() => { seedTopicQuiz(); seedInterview(); seedPractice(); }));

    it('keeps the three sources separate, each with its own figures', () => {
      expect(text(q('[data-source="topic-quiz"]'))).toContain('9 / 10 questions');
      expect(text(q('[data-source="interview"]'))).toContain('7 / 10 questions');
      expect(text(q('[data-source="weak-areas-practice"]'))).toContain('2 / 4 questions');
    });

    it('offers Practice Weak Areas when weak topics exist (existing behavior, unchanged)', () => {
      const practice = q('.progress-summary__practice') as HTMLButtonElement | null;
      expect(practice).not.toBeNull();
      expect(practice!.tagName).toBe('BUTTON');   // an action, not a navigation
      expect(text(practice)).toBe('Practice Weak Areas');
    });
  });

  // ── composition (relocated from the retired ProgressPanel spec) ─────

  describe('the dashboard composition', () => {
    it('shows the existing completion summary FIRST, with Performance Insights beneath it', () => {
      create(() => { seedTopicQuiz(); seedBestScore(); });
      const summary = q('codelab-progress-summary')!;
      const insights = q('codelab-performance-insights')!;
      expect(summary.compareDocumentPosition(insights) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      // The summary's own content is all still there, unchanged.
      const t = text(summary);
      expect(t).toContain('Overall Progress');
      expect(t).toContain('Beginner');
      expect(t).toContain('Average Score');
      expect(t).toContain('Needs Review');
    });

    it('is expanded — its content is visible without any disclosure control', () => {
      create(seedTopicQuiz);
      expect(q('[aria-expanded]')).toBeNull();
      expect(text(q('codelab-performance-insights'))).toContain('Performance Overview');
    });

    it('follows newly recorded history live, without being recreated', () => {
      create();
      expect(q('.progress-page__empty')).not.toBeNull();

      TestBed.inject(InterviewHistoryService).record(interviewResult(70));
      TestBed.tick();

      expect(q('.progress-page__empty')).toBeNull();
      expect(text(q('codelab-performance-insights'))).toContain('Interview Mode');
    });

    it('renders no accordion header text — the panel\'s "X of N completed" title is gone', () => {
      create(seedBestScore);
      expect(text(el)).not.toMatch(/\d+ of \d+ completed/);
    });
  });

  // ── legacy ────────────────────────────────────────────────────────

  describe('legacy user: a best score but no Performance Insights history', () => {
    beforeEach(() => create(seedBestScore));

    it('is NOT treated as a new user', () => {
      expect(q('.progress-page__empty')).toBeNull();
      expect(component.hasProgress()).toBe(true);
    });

    it('renders the completion summary from the best-score store', () => {
      const summary = text(q('codelab-progress-summary'));
      expect(summary).toContain('Overall Progress');
      expect(summary).toMatch(/Beginner\s*1 \/ \d+/);
    });

    it('lets Performance Insights show its own neutral no-data state — nothing invented', () => {
      expect(text(q('codelab-performance-insights'))).toContain(
        'Complete quizzes or interviews to build your performance history.'
      );
      expect(q('[data-source]')).toBeNull();
    });
  });

  // ── hasProgress ───────────────────────────────────────────────────

  describe('hasProgress — durable sources only', () => {
    it('is false with no durable progress', () => {
      create();
      expect(component.hasProgress()).toBe(false);
    });

    it('is true when the summary has a completed Topic Quiz', () => {
      create(seedBestScore);
      expect(component.summary().completedCount).toBeGreaterThan(0);
      expect(component.insights().hasData).toBe(false);
      expect(component.hasProgress()).toBe(true);
    });

    it('is true when Performance Insights has data', () => {
      create(seedInterview);
      expect(component.summary().completedCount).toBe(0);
      expect(component.insights().hasData).toBe(true);
      expect(component.hasProgress()).toBe(true);
    });

    it('does NOT need current-session engagement', () => {
      create(seedInterview);
      expect(TestBed.inject(SessionEngagementService).engaged()).toBe(false);
      expect(component.hasProgress()).toBe(true);
    });

    it('is NOT satisfied by session engagement alone', () => {
      create(() => TestBed.inject(SessionEngagementService).markEngaged());
      expect(TestBed.inject(SessionEngagementService).engaged()).toBe(true);
      expect(component.hasProgress()).toBe(false);
      expect(q('.progress-page__empty')).not.toBeNull();
    });

    it('is NOT satisfied by session-only Topic Quiz access markers', () => {
      create(() => {
        sessionStorage.setItem('startedQuizIds', JSON.stringify(['typescript']));
        sessionStorage.setItem('completedQuizIds', JSON.stringify(['typescript']));
      });
      expect(component.hasProgress()).toBe(false);
    });
  });

  // ── metadata ──────────────────────────────────────────────────────

  describe('the quiz catalog', () => {
    it('asks the API for the catalog once, on entry', () => {
      create();
      expect(http.match(`${API}/quizzes`)).toHaveLength(1);
    });

    it('rebuilds the summary from the API response when it arrives', () => {
      create(seedBestScore);
      http.expectOne(`${API}/quizzes`).flush({
        quizzes: [
          { quizId: 'typescript', milestone: 'TypeScript', difficulty: 'beginner', questionCount: 10 },
          { quizId: 'templates', milestone: 'Templates', difficulty: 'beginner', questionCount: 10 }
        ]
      });
      TestBed.tick();
      expect(text(q('codelab-progress-summary'))).toMatch(/Beginner\s*1 \/ 2/);
    });

    it('survives a failed request: no crash, the bundled seed stays in place', () => {
      create(seedBestScore);
      expect(() => http.expectOne(`${API}/quizzes`).error(new ProgressEvent('error'))).not.toThrow();
      TestBed.tick();
      expect(q('.progress-page')).not.toBeNull();
      expect(component.summary().totalCount).toBeGreaterThan(0);
      expect(component.hasProgress()).toBe(true);
    });

    it('survives a failed request for a new user too', () => {
      create();
      http.expectOne(`${API}/quizzes`).error(new ProgressEvent('error'));
      TestBed.tick();
      expect(q('.progress-page__empty')).not.toBeNull();
    });
  });

  // ── accessibility ─────────────────────────────────────────────────

  describe('accessibility', () => {
    it('has exactly one h1, and the empty state adds no other heading', () => {
      create();
      expect(qa('h1')).toHaveLength(1);
      expect(qa('h2, h3, h4')).toHaveLength(0);
    });

    it('never skips a heading level: h1 → h2 → h3', () => {
      create(() => { seedTopicQuiz(); seedInterview(); });
      const levels = qa('h1, h2, h3, h4, h5, h6').map((h) => Number(h.tagName[1]));
      expect(levels[0]).toBe(1);
      levels.forEach((level, i) => {
        if (i > 0) expect(level).toBeLessThanOrEqual(levels[i - 1] + 1);
      });
      expect(qa('h1')).toHaveLength(1);
      expect(qa('h2').map(text)).toEqual(['Performance Insights']);
      expect(qa('h3').length).toBeGreaterThan(0);
    });

    it('every navigation is a real link', () => {
      create(seedInterview);
      const nav = [link('Choose a Quiz'), link('Start an Interview')];
      expect(nav.every((a) => a?.tagName === 'A' && !!a.getAttribute('href'))).toBe(true);
    });

    it('moves focus to the page heading on entry, without making it a tab stop', () => {
      create();
      TestBed.tick();
      const h1 = q('h1')!;
      expect(h1.getAttribute('tabindex')).toBe('-1');
      expect(document.activeElement).toBe(h1);
    });
  });

});
