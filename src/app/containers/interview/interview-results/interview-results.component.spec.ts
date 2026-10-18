import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideRouter, Router } from '@angular/router';

import { InterviewResultsComponent } from './interview-results.component';
import type { InterviewResultViewModel } from '@shared/models/interview/interview-view-models';
import { BackendInterviewResultService } from '@shared/services/interview/backend-interview-result.service';
import { BackendInterviewSessionService } from '@shared/services/interview/backend-interview-session.service';
import { AssessmentIntegrityService } from '@shared/services/features/interview/assessment-integrity.service';

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
  total: 10,
  answered: 10,
  unanswered: 0,
  correct: 7,
  incorrect: 3,
  percentage: 70,
  durationSeconds: 900,
  timeUsedSeconds: 540,
  config: { mode: 'custom', difficulty: 'beginner', topicIds: ['router'], questionCount: 10 },
  byTopic: [
    {
      topicId: 'router',
      title: 'Angular Router',
      correct: 7,
      incorrect: 3,
      unanswered: 0,
      total: 10,
      percentage: 70
    }
  ],
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
          useValue: {
            result: signal(RESULT),
            error: signal(null),
            loading: signal(false),
            clear: clearResult,
            reload: jest.fn()
          }
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
  const text = (n: Element | null | undefined): string =>
    (n?.textContent ?? '').replace(/\s+/g, ' ').trim();

  it('offers "View Your Progress" beside "View Interview History", routed to /progress', () => {
    expect(gateway().map(text)).toEqual(['View Interview History', 'View Your Progress']);
    expect(gateway().map((a) => a.getAttribute('href'))).toEqual([
      '/interview/history',
      '/progress'
    ]);
  });

  it('the Interview History link still routes where it did', () => {
    expect(gateway()[0].getAttribute('href')).toBe('/interview/history');
  });

  // â”€â”€ Export Report â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  const exportLink = (): HTMLAnchorElement | undefined =>
    Array.from(el.querySelectorAll<HTMLAnchorElement>('.interview-results__actions a')).find(
      (a) => text(a) === 'Export Report'
    );

  it('offers "Export Report" for a finalized result, as a real link to that attempt report', () => {
    const link = exportLink()!;
    expect(link).toBeDefined();
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('/interview/report/is_test');
  });

  it('labels the Results action "Export Report" — the print wording belongs to the report page', () => {
    const actions = Array.from(
      el.querySelectorAll('.interview-results__actions a, .interview-results__actions button')
    ).map(text);
    expect(actions).toContain('Export Report');
    expect(actions.some((t) => /print|pdf/i.test(t))).toBe(false);
  });

  it('exporting is plain navigation: it does not end the session or drop the result', () => {
    const navigate = jest.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    exportLink()!.click();
    expect(clearSession).not.toHaveBeenCalled();
    expect(clearResult).not.toHaveBeenCalled();
    navigate.mockRestore();
  });

  it('leaves the existing Results actions untouched', () => {
    const actions = Array.from(
      el.querySelectorAll('.interview-results__actions a, .interview-results__actions button')
    ).map(text);
    expect(actions).toEqual([
      'Review Answers',
      'Export Report',
      'Build Another Assessment',
      'Return to Quiz Selection'
    ]);
  });

  it('navigates to /progress WITHOUT ending the session or dropping the result — like the history link', () => {
    const navigateByUrl = jest
      .spyOn(TestBed.inject(Router), 'navigateByUrl')
      .mockResolvedValue(true);

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

/**
 * CONFIRMED (2026-10-17, traced via real focus events): arriving here from
 * the session's "Submit Assessment" flow leaves focus on `document.body` —
 * the submit button that held it is destroyed on navigation, and nothing on
 * this page claimed focus. Narrator then finishes whatever it had queued on
 * the session screen instead of announcing this page. This asserts the fix:
 * "Assessment Complete" receives real DOM focus once, the first time a
 * result renders.
 */
describe('InterviewResultsComponent — entry focus', () => {
  let fixture: ComponentFixture<InterviewResultsComponent>;
  let el: HTMLElement;

  function render(result: InterviewResultViewModel | null): void {
    TestBed.configureTestingModule({
      imports: [InterviewResultsComponent],
      providers: [
        provideRouter([]),
        provideNoopAnimations(),
        {
          provide: BackendInterviewResultService,
          useValue: {
            result: signal(result),
            error: signal(null),
            loading: signal(false),
            clear: jest.fn(),
            reload: jest.fn()
          }
        },
        { provide: BackendInterviewSessionService, useValue: { clearSession: jest.fn() } }
      ]
    });
    fixture = TestBed.createComponent(InterviewResultsComponent);
    el = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();
  }

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('moves focus to "Assessment Complete" once a real result renders', async () => {
    render(RESULT);
    await fixture.whenStable();
    fixture.detectChanges();

    const heading = el.querySelector('.interview-results__title');
    expect(document.activeElement).toBe(heading);
    expect(heading!.getAttribute('tabindex')).toBe('-1');
  });

  it('does not focus anything when there is no result yet (guard-fallback error branch)', async () => {
    render(null);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(document.activeElement).not.toBe(el.querySelector('.interview-results__title'));
  });
});

/**
 * CONFIRMED (manual Narrator Scan Mode report, 2026-10-18): the score hero
 * and each stat-grid entry were read as separate lines (label, then value,
 * as two stops) instead of one coherent phrase. Fix: one combined phrase,
 * as real text; the existing visible pieces (dt/dd, score-pct/score-sub)
 * get `aria-hidden="true"` so they aren't ALSO read — one source, no
 * duplicate speech, values are the real dynamic result (not hardcoded),
 * and the visible layout/text is unchanged (aria-hidden never affects
 * rendering).
 *
 * SECOND CONFIRMED DEFECT: `role="group"` was first placed on the hidden
 * span itself — Narrator's highlight then landed to the right of the
 * visible card (the span's own clipped 1x1px box, not the card's).
 *
 * THIRD CONFIRMED DEFECT: moving `role="group"` to the real wrapper and
 * the hidden span off-screen fixed the shift but made the highlight
 * ABSENT — Narrator's actual reading target turned out to be the
 * text-bearing span itself, not necessarily its `role="group"`
 * ancestor, so an off-screen span produced an off-screen highlight. Fix:
 * the span now OVERLAYS its parent exactly (`inset:0` + `opacity:0` on a
 * `position:relative` parent, see the .scss file's own comment) —
 * confirmed via CDP that its own bounding box now matches the visible
 * card, so the highlight lands correctly regardless of which of the two
 * nodes Narrator targets.
 */
describe('InterviewResultsComponent — statistics read as one coherent group each', () => {
  let fixture: ComponentFixture<InterviewResultsComponent>;
  let el: HTMLElement;

  function render(result: InterviewResultViewModel): void {
    TestBed.configureTestingModule({
      imports: [InterviewResultsComponent],
      providers: [
        provideRouter([]),
        provideNoopAnimations(),
        {
          provide: BackendInterviewResultService,
          useValue: {
            result: signal(result),
            error: signal(null),
            loading: signal(false),
            clear: jest.fn(),
            reload: jest.fn()
          }
        },
        { provide: BackendInterviewSessionService, useValue: { clearSession: jest.fn() } }
      ]
    });
    fixture = TestBed.createComponent(InterviewResultsComponent);
    el = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();
  }

  const groupText = (selector: string): string | null =>
    (el.querySelector(`${selector} .visually-hidden-overlay`)?.textContent ?? null)
      ?.replace(/\s+/g, ' ')
      .trim() ?? null;

  it('exposes the score hero as one named object, using the actual values', () => {
    // role="img" (not "group" + hidden text — see scoreAccessibleSummary's
    // own comment): the name comes from aria-label so Narrator's highlight
    // tracks this real, already-correctly-sized element directly, with no
    // separate hidden leaf.
    render(RESULT); // percentage 70, correct 7, total 10
    const hero = el.querySelector('.score-hero')!;
    expect(hero.getAttribute('role')).toBe('img');
    expect(hero.getAttribute('aria-label')).toBe('70%, 7 out of 10 correct');
  });

  it('groups each stat-grid entry into one real-text phrase, using the actual values', () => {
    render(RESULT); // answered 10, unanswered 0, correct 7, incorrect 3, timeUsedSeconds 540, difficulty beginner
    const stats = el.querySelectorAll('.stat-grid > div');
    stats.forEach((div) => expect(div.getAttribute('role')).toBe('group'));
    const texts = Array.from(stats).map((div) =>
      div.querySelector('.visually-hidden-overlay')!.textContent!.replace(/\s+/g, ' ').trim()
    );
    expect(texts).toEqual([
      'Answered, 10',
      'Unanswered, 0',
      'Correct, 7',
      'Incorrect, 3',
      'Time used, 9 minutes 0 seconds',
      'Difficulty, Beginner'
    ]);
  });

  it('the score hero has no hidden text leaf — its name is an attribute on the real card itself', () => {
    render(RESULT);
    const card = el.querySelector('.score-hero')!;
    expect(card.getAttribute('role')).toBe('img');
    expect(card.querySelector('.visually-hidden-overlay')).toBeNull();
  });

  it('hides the duplicate visible pieces from the accessibility tree so nothing is spoken twice', () => {
    render(RESULT);
    expect(el.querySelector('.score-pct')!.getAttribute('aria-hidden')).toBe('true');
    expect(el.querySelector('.score-sub')!.getAttribute('aria-hidden')).toBe('true');
    el.querySelectorAll('.stat-grid dt, .stat-grid dd').forEach((node) => {
      expect(node.getAttribute('aria-hidden')).toBe('true');
    });
  });

  it('does not change the VISIBLE text or layout — aria-hidden only affects the accessibility tree', () => {
    render(RESULT);
    expect(el.querySelector('.score-pct')!.textContent!.trim()).toBe('70%');
    expect(el.querySelector('.score-sub')!.textContent).toContain('7 / 10');
    expect(el.querySelector('.stat-grid dd')!.textContent!.trim()).toBe('10'); // Answered
  });

  it('the new groups and hidden spans carry no tabindex and are not live regions — static content only', () => {
    render(RESULT);
    el.querySelectorAll('[role="group"], [role="img"], .visually-hidden-overlay').forEach((node) => {
      expect(node.getAttribute('tabindex')).toBeNull();
      expect(node.getAttribute('aria-live')).toBeNull();
    });
  });

  it('is absent for a role preset, which has no single difficulty (unchanged behavior)', () => {
    render({ ...RESULT, config: { ...RESULT.config, mode: 'preset', difficulty: undefined as never } });
    const stats = el.querySelectorAll('.stat-grid > div');
    expect(stats.length).toBe(5); // no Difficulty entry at all, same as before
  });
});

/**
 * CONFIRMED (manual Narrator report, 2026-10-18): "Focus changes:" and its
 * value were read as two separate stops; the user also reported pressing
 * Tab announced "0". Verified via a full real-page Tab-cycle trace that
 * this paragraph has no tabindex and is never a Tab stop — not an
 * unintended focusable element, so only the reading-grouping fix applies
 * here (same technique as the stat-grid, reusing this paragraph's own
 * real, already-correctly-sized box rather than adding a new element).
 */
describe('InterviewResultsComponent — "Focus changes" reads as one phrase, not a Tab stop', () => {
  let fixture: ComponentFixture<InterviewResultsComponent>;
  let el: HTMLElement;

  function render(focusLossCount: number): void {
    TestBed.configureTestingModule({
      imports: [InterviewResultsComponent],
      providers: [
        provideRouter([]),
        provideNoopAnimations(),
        {
          provide: BackendInterviewResultService,
          useValue: {
            result: signal(RESULT),
            error: signal(null),
            loading: signal(false),
            clear: jest.fn(),
            reload: jest.fn()
          }
        },
        { provide: BackendInterviewSessionService, useValue: { clearSession: jest.fn() } },
        {
          provide: AssessmentIntegrityService,
          useValue: { focusLossCount: signal(focusLossCount) }
        }
      ]
    });
    fixture = TestBed.createComponent(InterviewResultsComponent);
    el = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();
  }

  it('is not a Tab stop (no tabindex) — the reported "0" announcement on Tab is not this element', () => {
    render(3);
    const p = el.querySelector('.interview-results__focus')!;
    expect(p.getAttribute('tabindex')).toBeNull();
    expect((p as HTMLElement).tabIndex).toBeLessThan(0);
  });

  it('exposes one combined "Focus changes, {count}" phrase, using the real dynamic count', () => {
    render(3);
    const p = el.querySelector('.interview-results__focus')!;
    expect(p.getAttribute('role')).toBe('group');
    const hidden = p.querySelector('.visually-hidden-overlay')!;
    expect(hidden.textContent!.replace(/\s+/g, ' ').trim()).toBe('Focus changes, 3');
    expect(hidden.getAttribute('role')).toBeNull();
  });

  it('hides the always-visible text from the accessibility tree so nothing is spoken twice', () => {
    render(0);
    const p = el.querySelector('.interview-results__focus')!;
    const visible = p.querySelector('span[aria-hidden="true"]')!;
    expect(visible.getAttribute('aria-hidden')).toBe('true');
  });

  it('does not change the visible text ("Focus changes: 0") or layout', () => {
    render(0);
    const visible = el.querySelector('.interview-results__focus span[aria-hidden="true"]')!;
    expect(visible.textContent!.replace(/\s+/g, ' ').trim()).toBe('Focus changes: 0');
  });

  it('carries no aria-live — static content only', () => {
    render(0);
    const p = el.querySelector('.interview-results__focus')!;
    expect(p.getAttribute('aria-live')).toBeNull();
  });
});

