import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideRouter, Router } from '@angular/router';

import { InterviewResultsComponent } from './interview-results.component';
import type { InterviewResultViewModel } from '../../../shared/models/interview/interview-view-models';
import { BackendInterviewResultService } from '../../../shared/services/interview/backend-interview-result.service';
import { BackendInterviewSessionService } from '../../../shared/services/interview/backend-interview-session.service';

/**
 * Interview Results — navigation off this single attempt.
 *
 * "View Your Progress" sits beside the existing "View Interview History" and,
 * like it, is a plain link: neither ends the session or drops the result.
 * Leaving through "Build Another" / "Return to Quiz Selection" still does.
 */
const RESULT: InterviewResultViewModel = {
  sessionId: 'is_test',
  submittedAtMs: Date.UTC(2026, 8, 1, 10),
  submittedByExpiry: false,
  total: 10, answered: 10, unanswered: 0, correct: 7, incorrect: 3, percentage: 70,
  durationSeconds: 900, timeUsedSeconds: 540,
  config: { mode: 'custom', difficulty: 'beginner', topicIds: ['router'], questionCount: 10 },
  byTopic: [{ topicId: 'router', title: 'Angular Router', correct: 7, incorrect: 3, unanswered: 0, total: 10, percentage: 70 }],
  review: []
};

describe('InterviewResultsComponent — navigation actions', () => {
  let fixture: ComponentFixture<InterviewResultsComponent>;
  let el: HTMLElement;
  const clearResult = jest.fn();
  const clearSession = jest.fn();

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    clearResult.mockClear();
    clearSession.mockClear();

    TestBed.configureTestingModule({
      imports: [InterviewResultsComponent],
      providers: [
        provideRouter([]),
        provideNoopAnimations(),
        {
          provide: BackendInterviewResultService,
          useValue: { result: signal(RESULT), error: signal(null), loading: signal(false), clear: clearResult, reload: jest.fn() }
        },
        { provide: BackendInterviewSessionService, useValue: { clearSession } }
      ]
    });
    fixture = TestBed.createComponent(InterviewResultsComponent);
    el = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  const gateway = (): HTMLAnchorElement[] =>
    Array.from(el.querySelectorAll<HTMLAnchorElement>('.interview-results__history-link a'));
  const text = (n: Element | null | undefined): string => (n?.textContent ?? '').replace(/\s+/g, ' ').trim();

  it('offers "View Your Progress" beside "View Interview History", routed to /progress', () => {
    expect(gateway().map(text)).toEqual(['View Interview History', 'View Your Progress']);
    expect(gateway().map((a) => a.getAttribute('href'))).toEqual(['/interview/history', '/progress']);
  });

  it('the Interview History link still routes where it did', () => {
    expect(gateway()[0].getAttribute('href')).toBe('/interview/history');
  });

  it('navigates to /progress WITHOUT ending the session or dropping the result — like the history link', () => {
    const navigateByUrl = jest.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);

    gateway()[1].click();

    expect(navigateByUrl).toHaveBeenCalledTimes(1);
    expect(navigateByUrl.mock.calls[0][0].toString()).toBe('/progress');
    expect(clearResult).not.toHaveBeenCalled();
    expect(clearSession).not.toHaveBeenCalled();
  });

  it('leaving through "Return to Quiz Selection" STILL ends the session (unchanged)', () => {
    const navigate = jest.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

    fixture.componentInstance.returnToSelection();

    expect(clearResult).toHaveBeenCalledTimes(1);
    expect(clearSession).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(['/quiz']);
  });

  it('leaving through "Build Another Assessment" STILL ends the session (unchanged)', () => {
    const navigate = jest.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

    fixture.componentInstance.buildAnother();

    expect(clearResult).toHaveBeenCalledTimes(1);
    expect(clearSession).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(['/interview']);
  });

  it('does not alter the result shown: score, counts and kind label are as before', () => {
    expect(text(el.querySelector('.score-pct'))).toBe('70%');
    expect(text(el.querySelector('.score-sub'))).toContain('7 / 10');
    expect(text(el.querySelector('.interview-results__kind'))).toBe('Custom Interview');
  });
});
