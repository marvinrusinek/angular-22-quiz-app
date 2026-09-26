import { signal, WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { InterviewReportComponent } from './interview-report.component';
import type { InterviewResultViewModel } from '@shared/models/interview/interview-view-models';
import { BackendInterviewResultService } from '@shared/services/interview/backend-interview-result.service';

const SESSION_ID = 'is_SECRET_session_123';
const QUESTION_ID = 'q_INTERNAL_question_777';
const SOURCE_QUIZ_ID = 'source-quiz-internal-id';
const SUBMITTED = new Date(2026, 8, 26, 12, 0, 0).getTime();   // local noon

function makeResult(over: Partial<InterviewResultViewModel> = {}): InterviewResultViewModel {
  return {
    sessionId: SESSION_ID,
    submittedAtMs: SUBMITTED,
    submittedByExpiry: false,
    total: 3, answered: 2, unanswered: 1, correct: 1, incorrect: 1, percentage: 33,
    durationSeconds: 1800, timeUsedSeconds: 754,
    config: { mode: 'preset', presetId: 'mid-level', topicIds: ['router', 'forms'], questionCount: 3 },
    byTopic: [
      { topicId: 'router', title: 'Angular Router', correct: 1, incorrect: 1, unanswered: 0, total: 2, percentage: 50 },
      { topicId: 'forms', title: 'Angular Forms', correct: 0, incorrect: 0, unanswered: 1, total: 1, percentage: 0 }
    ],
    review: [
      {
        questionId: QUESTION_ID, sourceQuizId: SOURCE_QUIZ_ID, questionText: 'Which <b>router</b> method navigates?',
        type: 'single', options: [{ optionId: 1, text: 'navigate()' }, { optionId: 2, text: 'go()' }],
        selectedOptionIds: [1], correctOptionIds: [1], explanation: 'navigate() is the Router API.',
        isCorrect: true, isAnswered: true, flagged: true,
        codeSnippet: { language: 'typescript', code: 'router.navigate([\'/home\']);', filename: 'nav.ts' }
      },
      {
        questionId: 'q2', sourceQuizId: SOURCE_QUIZ_ID, questionText: 'Pick the guard type.',
        type: 'single', options: [{ optionId: 1, text: 'CanActivate' }, { optionId: 2, text: 'CanRun' }],
        selectedOptionIds: [2], correctOptionIds: [1], explanation: 'CanActivate guards routes.',
        isCorrect: false, isAnswered: true, flagged: false
      },
      {
        questionId: 'q3', sourceQuizId: 'forms', questionText: 'Name a form class.',
        type: 'single', options: [{ optionId: 1, text: 'FormGroup' }, { optionId: 2, text: 'FormBox' }],
        selectedOptionIds: [], correctOptionIds: [1], explanation: 'FormGroup groups controls.',
        isCorrect: false, isAnswered: false, flagged: false
      }
    ],
    ...over
  };
}

describe('InterviewReportComponent', () => {
  let result: WritableSignal<InterviewResultViewModel | null>;
  let el: HTMLElement;
  let printSpy: jest.SpyInstance;
  let scrollSpy: jest.SpyInstance;

  async function open(sessionId = SESSION_ID): Promise<InterviewReportComponent> {
    const harness = await RouterTestingHarness.create();
    const component = await harness.navigateByUrl(`/interview/report/${sessionId}`, InterviewReportComponent);
    harness.detectChanges();
    el = harness.routeNativeElement as HTMLElement;
    return component;
  }

  const q = (sel: string): HTMLElement | null => el.querySelector<HTMLElement>(sel);
  const qa = (sel: string): HTMLElement[] => Array.from(el.querySelectorAll<HTMLElement>(sel));
  const text = (n: Element | null | undefined): string => (n?.textContent ?? '').replace(/\s+/g, ' ').trim();

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    document.title = 'Angular Quiz App';
    result = signal<InterviewResultViewModel | null>(makeResult());
    printSpy = jest.spyOn(window, 'print').mockImplementation(() => undefined);
    scrollSpy = jest.spyOn(window, 'scrollTo').mockImplementation(() => undefined);   // jsdom: not implemented
    TestBed.configureTestingModule({
      providers: [
        provideNoopAnimations(),
        provideRouter([{ path: 'interview/report/:sessionId', component: InterviewReportComponent }]),
        { provide: BackendInterviewResultService, useValue: { result: result.asReadonly() } }
      ]
    });
  });

  afterEach(() => {
    printSpy.mockRestore();
    scrollSpy.mockRestore();
    localStorage.clear();
    sessionStorage.clear();
  });

  describe('content', () => {
    beforeEach(() => open());

    it('has one h1 "Interview Report", h2 sections and question h3s — no skipped level', () => {
      expect(qa('h1').map(text)).toEqual(['Interview Report']);
      expect(qa('h2').map(text)).toEqual(['Summary', 'Performance by Topic', 'Question Review']);
      const levels = qa('h1, h2, h3, h4').map((h) => Number(h.tagName[1]));
      levels.forEach((l, i) => { if (i > 0) expect(l).toBeLessThanOrEqual(levels[i - 1] + 1); });
      expect(qa('h3').length).toBeGreaterThanOrEqual(3);
    });

    it('shows the preset name and the completion date in the header', () => {
      expect(text(q('.rp__kind'))).toBe('Mid-Level Angular Developer');
      expect(text(q('.rp__date'))).toBe('September 26, 2026');
      expect(q('.rp__difficulty')).toBeNull();          // a preset mixes difficulties
    });

    it('shows the finalized summary values as a description list', () => {
      const rows = Object.fromEntries(qa('.rp-summary > div').map((d) => [text(d.querySelector('dt')), text(d.querySelector('dd'))]));
      expect(rows).toEqual({
        Score: '1 / 3', Percentage: '33%', Correct: '1', Incorrect: '1', Unanswered: '1',
        'Total duration': '30m 0s', 'Time used': '12m 34s'
      });
    });

    it('renders Performance by Topic as an accessible table', () => {
      const table = q('table.rp-topics')!;
      expect(qa('table.rp-topics thead th').map((h) => h.getAttribute('scope'))).toEqual(Array(6).fill('col'));
      expect(text(table.querySelector('caption'))).toContain('for each topic');
      const rows = qa('table.rp-topics tbody tr').map((tr) => Array.from(tr.children).map(text));
      expect(rows).toEqual([
        ['Angular Router', '1', '1', '0', '2', '50%'],
        ['Angular Forms', '0', '0', '1', '1', '0%']
      ]);
      expect(qa('table.rp-topics tbody th').every((th) => th.getAttribute('scope') === 'row')).toBe(true);
    });

    it('renders EVERY reviewed question through the existing Review component', () => {
      expect(q('app-interview-review')).not.toBeNull();
      expect(qa('article.rv-item')).toHaveLength(3);
    });

    it('distinguishes correct, incorrect and unanswered in TEXT, not just colour', () => {
      const items = qa('article.rv-item').map(text);
      expect(items[0]).toContain('Correct');
      expect(items[1]).toContain('Incorrect');
      expect(items[2]).toContain('You did not answer this question.');
    });

    it('shows correct answer(s), explanations and the flagged (marked-for-review) state', () => {
      const all = text(q('app-interview-review'));
      expect(all).toContain('Correct answers:');
      expect(all).toContain('navigate() is the Router API.');
      expect(all).toContain('CanActivate guards routes.');
      expect(qa('.rv-flag-badge')).toHaveLength(1);
    });

    it('renders the code snippet through the existing sanitized path', () => {
      expect(q('app-code-snippet')).not.toBeNull();
      expect(text(q('app-code-snippet'))).toContain('router.navigate');
    });

    it('the report\'s own controls are only Print and Back — it adds no filtering of its own', () => {
      // The Review component's filter toolbar and summary are hidden by the report
      // stylesheet (jsdom applies no CSS): the browser E2E asserts they are not visible.
      expect(qa('.rp__actions button').map(text)).toEqual(['Print / Save as PDF']);
      expect(qa('.rp__actions a').map(text)).toEqual(['Back to Results']);
      expect(qa('.rv-filters-toolbar').length).toBe(1);   // the element the hiding rule targets exists
    });
  });

  describe('conditional content', () => {
    it('shows the auto-submit note only when the attempt expired', async () => {
      await open();
      expect(q('.rp__expiry')).toBeNull();

      result.set(makeResult({ submittedByExpiry: true }));
      TestBed.tick();
      expect(text(q('.rp__expiry'))).toContain('submitted automatically');
    });

    it('shows the chosen difficulty for a custom interview and calls it Custom Interview', async () => {
      result.set(makeResult({ config: { mode: 'custom', difficulty: 'advanced', topicIds: ['router'], questionCount: 3 } }));
      await open();
      expect(text(q('.rp__kind'))).toBe('Custom Interview');
      expect(text(q('.rp__difficulty'))).toBe('Advanced');
    });

    it('handles an attempt with no topic breakdown and no review without inventing data', async () => {
      result.set(makeResult({ byTopic: [], review: [], total: 0, answered: 0, unanswered: 0, correct: 0, incorrect: 0, percentage: 0 }));
      await open();
      expect(q('table.rp-topics')).toBeNull();
      expect(text(q('.rp__empty'))).toContain('No topic breakdown');
      expect(qa('article.rv-item')).toHaveLength(0);
    });
  });

  describe('privacy', () => {
    it('renders no session id, token, question id, source-quiz id, focus counter or API detail', async () => {
      await open();
      const visible = (el.innerText ?? el.textContent ?? '');
      for (const secret of [SESSION_ID, QUESTION_ID, SOURCE_QUIZ_ID, 'Bearer', 'token', 'localhost', '/api', 'Focus changes', 'focusChanges']) {
        expect(visible).not.toContain(secret);
      }
    });

    it('offers no name/email/identity field', async () => {
      await open();
      expect(qa('input, textarea, select')).toHaveLength(0);
      expect(text(el).toLowerCase()).not.toMatch(/candidate|e-?mail|full name/);
    });

    it('writes NOTHING to localStorage or sessionStorage — no answer-bearing report data persists', async () => {
      const component = await open();
      component.print();
      expect(Object.keys(localStorage).filter((k) => k !== 'quiz-app-theme')).toEqual([]);
      expect(Object.keys(sessionStorage)).toEqual([]);
    });
  });

  describe('actions', () => {
    it('Print / Save as PDF is a real, labelled button that opens the native print flow', async () => {
      await open();
      const btn = qa('button').find((b) => text(b) === 'Print / Save as PDF')!;
      expect(btn.getAttribute('type')).toBe('button');
      btn.click();
      expect(printSpy).toHaveBeenCalledTimes(1);
    });

    it('Back to Results is a router link to the SAME attempt — not a session-ending action', async () => {
      await open();
      const back = qa('a').find((a) => text(a) === 'Back to Results') as HTMLAnchorElement;
      expect(back.getAttribute('href')).toBe(`/interview/results/${SESSION_ID}`);
      expect(qa('button').some((b) => /return|selection|build another/i.test(text(b)))).toBe(false);
    });

    it('marks the on-screen controls as non-printing', async () => {
      await open();
      const bar = q('.rp__actions')!;
      expect(bar.classList).toContain('rp-noprint');
      expect(bar.querySelectorAll('button, a')).toHaveLength(2);
    });

    it('moves focus to the heading on entry without making it a tab stop', async () => {
      await open();
      TestBed.tick();
      const h1 = q('h1')!;
      expect(h1.getAttribute('tabindex')).toBe('-1');
      expect(document.activeElement).toBe(h1);
    });
  });

  describe('print title (suggested file name)', () => {
    const EXPECTED = 'Angular-Interview-Report-Mid-2026-09-26';

    it('sets the report title for printing and restores the previous title afterwards', async () => {
      const component = await open();
      const title = TestBed.inject(Title);
      expect(title.getTitle()).toBe('Angular Quiz App');

      printSpy.mockImplementation(() => { expect(document.title).toBe(EXPECTED); });   // in effect DURING print
      component.print();
      expect(document.title).toBe(EXPECTED);

      window.dispatchEvent(new Event('afterprint'));
      expect(document.title).toBe('Angular Quiz App');
    });

    it('also applies to Ctrl/Cmd+P (beforeprint) and restores on afterprint', async () => {
      await open();
      window.dispatchEvent(new Event('beforeprint'));
      expect(document.title).toBe(EXPECTED);
      window.dispatchEvent(new Event('afterprint'));
      expect(document.title).toBe('Angular Quiz App');
    });

    it('restores after a CANCELLED print too (afterprint fires either way)', async () => {
      const component = await open();
      component.print();
      window.dispatchEvent(new Event('afterprint'));
      window.dispatchEvent(new Event('afterprint'));            // idempotent
      expect(document.title).toBe('Angular Quiz App');
    });

    it('never captures its own title as the "original" on a repeated print', async () => {
      const component = await open();
      component.print();
      component.print();
      window.dispatchEvent(new Event('afterprint'));
      expect(document.title).toBe('Angular Quiz App');
    });

    it('restores the title if the user leaves the page without an afterprint', async () => {
      const component = await open();
      component.print();
      expect(document.title).toBe(EXPECTED);
      TestBed.resetTestingModule();                              // destroys the component
      expect(document.title).toBe('Angular Quiz App');
      expect(component).toBeTruthy();
    });

    it('the title contains no session id or internal identifier', async () => {
      const component = await open();
      component.print();
      expect(document.title).not.toContain('SECRET');
      expect(document.title).toMatch(/^[A-Za-z0-9-]+$/);
    });

    it('does not touch the title when there is no finalized result to print', async () => {
      result.set(null);
      const component = await open();
      component.print();
      expect(document.title).toBe('Angular Quiz App');
    });
  });

  describe('unavailable report', () => {
    it('shows a friendly message, not stale or empty data, when no result is held', async () => {
      result.set(null);
      await open();
      expect(text(q('[role="alert"]'))).toContain('no longer available');
      expect(qa('article.rv-item')).toHaveLength(0);
      expect(q('table')).toBeNull();
      expect(qa('a').map((a) => a.getAttribute('href'))).toEqual(['/interview']);
    });

    it('never shows a DIFFERENT session\'s result under this URL', async () => {
      await open('is_some_other_session');
      expect(q('.rp-summary')).toBeNull();
      expect(text(q('[role="alert"]'))).toContain('no longer available');
    });
  });

  it('is unaffected by the app theme: the saved theme is never touched by printing', async () => {
    localStorage.setItem('quiz-app-theme', 'dark');
    const component = await open();
    component.print();
    window.dispatchEvent(new Event('afterprint'));
    expect(localStorage.getItem('quiz-app-theme')).toBe('dark');
    expect(TestBed.inject(Router)).toBeTruthy();
  });
});
