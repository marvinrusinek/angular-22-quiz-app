import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { of, Subject, throwError } from 'rxjs';

import { InterviewSessionComponent } from './interview-session.component';
import { BackendInterviewSessionService } from '@shared/services/interview/backend-interview-session.service';
import { InterviewSessionReferenceStorage } from '@shared/services/interview/interview-session-reference.storage';
import { InterviewApiService } from '@shared/services/api/interview-api.service';
import { InterviewApiError } from '@shared/services/api/interview-api.errors';
import { BackendInterviewTimerService } from '@shared/services/interview/backend-interview-timer.service';
import { BackendInterviewResultService } from '@shared/services/interview/backend-interview-result.service';
import { InterviewHistoryService } from '@shared/services/features/interview/interview-history.service';
import type { InterviewResultViewModel, InterviewSessionViewModel } from '@shared/models/interview/interview-view-models';
import type { SaveInterviewAnswerResponse } from '@shared/models/api/interview-api.dto';

/**
 * The active session renders BACKEND-SAFE models only: no correctness, no
 * explanation, no local scoring. Multi-select comes from the server type.
 */
const TOKEN = 'a'.repeat(43);

const QUESTIONS = [
  {
    questionId: 'rxjs:q:0', sourceQuizId: 'rxjs',
    questionText: 'Which answer is correct?', type: 'single' as const,
    options: [{ optionId: 101, text: 'A' }, { optionId: 102, text: 'B' }],
    flagged: false
  },
  {
    questionId: 'rxjs:q:1', sourceQuizId: 'rxjs',
    questionText: 'Select all that apply', type: 'multiple' as const,
    options: [{ optionId: 201, text: 'C' }, { optionId: 202, text: 'D' }, { optionId: 203, text: 'E' }],
    flagged: false
  },
  {
    questionId: 'signals:q:0', sourceQuizId: 'signals',
    questionText: 'True or false?', type: 'trueFalse' as const,
    options: [{ optionId: 301, text: 'True' }, { optionId: 302, text: 'False' }],
    flagged: false
  }
];

function session(
  answers = new Map<string, readonly number[]>(),
  flags = new Map<string, boolean>()
): InterviewSessionViewModel {
  return {
    sessionId: 'is_1', status: 'active',
    createdAtMs: 1_700_000_000_000, expiresAtMs: 1_700_000_900_000,
    durationSeconds: 900, remainingSeconds: 900,
    config: { mode: 'custom', difficulty: 'mixed', topicIds: ['rxjs'], questionCount: 3 },
    questions: QUESTIONS,
    answers,
    flags
  };
}

const saved = (questionId: string, ids: number[], answeredCount = 1): SaveInterviewAnswerResponse =>
  ({ saved: true, questionId, selectedOptionIds: ids, answeredCount, questionCount: 3 });

let fixture: ComponentFixture<InterviewSessionComponent>;
let rendered = false;
let component: InterviewSessionComponent;
let backend: BackendInterviewSessionService;
let api: {
  saveAnswer: jest.Mock; submitSession: jest.Mock; resumeSession: jest.Mock; setReviewFlag: jest.Mock;
  getResult: jest.Mock;
};
let router: Router;

function render(answers?: Map<string, readonly number[]>, flags?: Map<string, boolean>): void {
  backend = TestBed.inject(BackendInterviewSessionService);
  backend.activateCreatedSession(session(answers, flags), TOKEN);

  fixture = TestBed.createComponent(InterviewSessionComponent);
  rendered = true;
  component = fixture.componentInstance;
  fixture.detectChanges();
}

/** Reach the private submit() the way expiry and the dialog do. */
const invokeSubmit = (): Promise<void> =>
  (component as unknown as { submit: () => Promise<void> }).submit();

/**
 * Saves are serialized per question, so the request is issued a microtask after
 * the click. A gated Subject must not emit before that subscription exists.
 */
const settleMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  api = {
    saveAnswer: jest.fn(), submitSession: jest.fn(), resumeSession: jest.fn(),
    setReviewFlag: jest.fn(), getResult: jest.fn()
  };

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [InterviewSessionComponent],
    providers: [
      provideRouter([]),
      provideNoopAnimations(),
      BackendInterviewSessionService,
      InterviewSessionReferenceStorage,
      BackendInterviewTimerService,
      BackendInterviewResultService,
      InterviewHistoryService,
      { provide: InterviewApiService, useValue: api }
    ]
  });
  router = TestBed.inject(Router);
  jest.spyOn(router, 'navigate').mockResolvedValue(true);
});
afterEach(() => {
  // The display countdown runs on a real interval; without a destroy it keeps
  // ticking after the test and jest reports a leaked worker handle.
  if (rendered) {
    fixture.destroy();
    rendered = false;
  }
  sessionStorage.clear();
});

describe('rendering', () => {
  it('renders the hydrated question text', () => {
    render();
    expect(fixture.nativeElement.querySelector('.interview-question').textContent)
      .toContain('Which answer is correct?');
  });

  it('does NOT resume again — the guard already hydrated', () => {
    render();
    expect(api.resumeSession).not.toHaveBeenCalled();
  });

  it('renders a SINGLE question as radios', () => {
    render();
    expect(fixture.nativeElement.querySelectorAll('input[type="radio"]').length).toBe(2);
  });

  it('renders a MULTIPLE question as checkboxes, with no correctness present', () => {
    render();
    component.onNavigate(1);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('input[type="checkbox"]').length).toBe(3);
    expect(component.questionType()).toBe('multiple');
    expect(JSON.stringify(component.currentOptions())).not.toContain('correct');
  });

  it('renders TRUE/FALSE as single-select', () => {
    render();
    component.onNavigate(2);
    fixture.detectChanges();
    expect(component.questionType()).toBe('trueFalse');
    expect(fixture.nativeElement.querySelectorAll('input[type="radio"]').length).toBe(2);
  });

  it('renders no explanation and no correctness classes', () => {
    render();
    const html = fixture.nativeElement.innerHTML as string;
    expect(html).not.toMatch(/correct-option|incorrect-option|explanation/);
  });

  it('restores saved answers and preserves question/option order', () => {
    render(new Map([['rxjs:q:1', [201, 203]]]));
    expect(component.questions().map((q) => q.questionId))
      .toEqual(['rxjs:q:0', 'rxjs:q:1', 'signals:q:0']);
    component.onNavigate(1);
    expect(component.selectedIds()).toEqual([201, 203]);
    expect(component.currentOptions().map((o) => o.optionId)).toEqual([201, 202, 203]);
  });

  it('answered count and paginator markers use CONFIRMED answers', () => {
    render(new Map([['rxjs:q:1', [201]]]));
    expect(component.answeredCount()).toBe(1);
    expect([...component.answeredIndices()]).toEqual([1]);
  });
});

describe('code snippet', () => {
  it('does not render app-code-snippet when the question has none', () => {
    render();
    expect(fixture.nativeElement.querySelector('app-code-snippet')).toBeNull();
  });

  it('renders app-code-snippet with the question when present', () => {
    backend = TestBed.inject(BackendInterviewSessionService);
    backend.activateCreatedSession({
      ...session(),
      questions: [
        { ...QUESTIONS[0]!, codeSnippet: { language: 'typescript', code: 'const x = 1;', filename: 'x.ts' } },
        ...QUESTIONS.slice(1)
      ]
    }, TOKEN);
    fixture = TestBed.createComponent(InterviewSessionComponent);
    rendered = true;
    component = fixture.componentInstance;
    fixture.detectChanges();

    const snippetEl = fixture.nativeElement.querySelector('app-code-snippet');
    expect(snippetEl).not.toBeNull();
    expect(snippetEl.textContent).toContain('const x = 1;');
  });
});

describe('saving', () => {
  it('shows the optimistic selection immediately, then the canonical value', async () => {
    render();
    api.saveAnswer.mockReturnValue(of(saved('rxjs:q:0', [101])));

    const promise = component.onSelectionChange([101]);
    expect(component.selectedIds()).toEqual([101]);
    await promise;
    fixture.detectChanges();

    expect(api.saveAnswer).toHaveBeenCalledWith('is_1', TOKEN, 'rxjs:q:0', [101]);
    expect(component.answeredCount()).toBe(1);
  });

  it('shows a saving indicator and blocks navigation while pending', async () => {
    render();
    const gate = new Subject<SaveInterviewAnswerResponse>();
    api.saveAnswer.mockReturnValue(gate);

    const promise = component.onSelectionChange([101]);
    await settleMicrotasks();
    fixture.detectChanges();

    expect(component.isSavingCurrent()).toBe(true);
    expect(component.navigationBlocked()).toBe(true);
    expect(fixture.nativeElement.textContent).toContain('Saving');

    gate.next(saved('rxjs:q:0', [101]));
    gate.complete();
    await promise;
    fixture.detectChanges();

    expect(component.navigationBlocked()).toBe(false);
  });

  it('blocks paginator, keyboard and submit while a save is pending', async () => {
    render();
    const gate = new Subject<SaveInterviewAnswerResponse>();
    api.saveAnswer.mockReturnValue(gate);
    const promise = component.onSelectionChange([101]);
    await settleMicrotasks();
    fixture.detectChanges();

    component.onNavigate(2);
    expect(component.currentIndex()).toBe(0);

    component.onGlobalKey(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(component.currentIndex()).toBe(0);

    component.onShowResults();
    expect(api.submitSession).not.toHaveBeenCalled();

    gate.next(saved('rxjs:q:0', [101]));
    gate.complete();
    await promise;
  });

  it('ROLLS BACK to the confirmed answer, flags it and BLOCKS navigation when a save fails', async () => {
    render(new Map([['rxjs:q:0', [101]]]));
    api.saveAnswer.mockReturnValue(throwError(() => new InterviewApiError('BACKEND_UNAVAILABLE', 0)));

    await component.onSelectionChange([102]);
    fixture.detectChanges();

    // The screen shows the SERVER's answer — never an unsaved one.
    expect(component.selectedIds()).toEqual([101]);
    expect(backend.confirmedAnswers().get('rxjs:q:0')).toEqual([101]);
    expect(component.hasFailedCurrent()).toBe(true);
    expect(component.navigationBlocked()).toBe(true);
    expect(fixture.nativeElement.textContent).toContain('could not be saved');
    // ...and there is no Undo: the confirmed state is already what is rendered.
    expect(fixture.nativeElement.textContent).not.toContain('Undo');
  });

  it('retry resends the INTENDED selection and unblocks on success', async () => {
    render(new Map([['rxjs:q:0', [101]]]));
    api.saveAnswer.mockReturnValueOnce(throwError(() => new InterviewApiError('BACKEND_UNAVAILABLE', 0)));
    await component.onSelectionChange([102]);
    expect(component.selectedIds()).toEqual([101]);
    expect(component.navigationBlocked()).toBe(true);

    api.saveAnswer.mockReturnValue(of(saved('rxjs:q:0', [102])));
    await component.retrySave();
    fixture.detectChanges();

    // [102] came from internal retry state, not from what was on screen.
    expect(api.saveAnswer).toHaveBeenLastCalledWith('is_1', TOKEN, 'rxjs:q:0', [102]);
    expect(component.selectedIds()).toEqual([102]);
    expect(component.hasFailedCurrent()).toBe(false);
    expect(component.navigationBlocked()).toBe(false);
    expect(fixture.nativeElement.textContent).not.toContain('could not be saved');
  });

  it('a newer selection supersedes the failed retry intent', async () => {
    render(new Map([['rxjs:q:0', [101]]]));
    api.saveAnswer.mockReturnValueOnce(throwError(() => new InterviewApiError('BACKEND_UNAVAILABLE', 0)));
    await component.onSelectionChange([102]);

    api.saveAnswer.mockReturnValue(of(saved('rxjs:q:0', [101])));
    await component.onSelectionChange([101]);

    api.saveAnswer.mockClear();
    await component.retrySave();

    expect(api.saveAnswer).not.toHaveBeenCalled();   // no stale [102] resend
    expect(component.selectedIds()).toEqual([101]);
    expect(component.navigationBlocked()).toBe(false);
  });

  it('a FAILED save leaves no paginator marker', async () => {
    render();
    api.saveAnswer.mockReturnValue(throwError(() => new InterviewApiError('BACKEND_UNAVAILABLE', 0)));
    await component.onSelectionChange([101]);
    expect([...component.answeredIndices()]).toEqual([]);
  });
});

describe('navigation', () => {
  it('persists the current index through the service', () => {
    render(new Map([['rxjs:q:0', [101]]]));
    component.onNavigate(1);
    expect(component.currentIndex()).toBe(1);
    expect(TestBed.inject(InterviewSessionReferenceStorage).read()?.currentIndex).toBe(1);
  });

  it('forward keyboard needs an answer; backward is always allowed', () => {
    render();
    component.onGlobalKey(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(component.currentIndex()).toBe(0);          // unanswered → blocked

    component.onNavigate(1);
    expect(component.currentIndex()).toBe(1);
    component.onGlobalKey(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    expect(component.currentIndex()).toBe(0);
  });

  it('gating never consults correctness or completeness', () => {
    render(new Map([['rxjs:q:1', [201]]]));   // one of three on a multiple
    component.onNavigate(1);
    expect(component.canNavigateNext()).toBe(true);
  });
});

describe('timer', () => {
  it('starts from the SERVER remaining seconds, not a full restart', () => {
    render();
    const timer = TestBed.inject(BackendInterviewTimerService);
    expect(timer.remainingSeconds()).toBe(900);
    expect(timer.durationSeconds()).toBe(900);
  });

  it('has no pause/resume — the server deadline never stops', () => {
    const timer = TestBed.inject(BackendInterviewTimerService) as unknown as Record<string, unknown>;
    expect(timer['pause']).toBeUndefined();
    expect(timer['resume']).toBeUndefined();
  });
});

describe('submission', () => {
  it('submits through the backend and navigates to results', async () => {
    render();
    api.submitSession.mockReturnValue(of({ sessionId: 'is_1' }));

    await invokeSubmit();

    // Only the id and token — no answers, score or reason.
    expect(api.submitSession).toHaveBeenCalledWith('is_1', TOKEN);
    expect(api.submitSession).toHaveBeenCalledTimes(1);
    expect(router.navigate).toHaveBeenCalledWith(['/interview/results', 'is_1']);
  });

  it('suppresses duplicate submissions', async () => {
    render();
    api.submitSession.mockReturnValue(of({ sessionId: 'is_1' }));
    await Promise.all([invokeSubmit(), invokeSubmit()]);
    expect(api.submitSession).toHaveBeenCalledTimes(1);
  });

  it('a failed save blocks submission', async () => {
    render();
    api.saveAnswer.mockReturnValue(throwError(() => new InterviewApiError('BACKEND_UNAVAILABLE', 0)));
    await component.onSelectionChange([101]);

    component.onShowResults();
    expect(api.submitSession).not.toHaveBeenCalled();
  });

  it('EXPIRY submits once and never sends submittedByExpiry', async () => {
    render();
    api.submitSession.mockReturnValue(of({ sessionId: 'is_1' }));

    TestBed.inject(BackendInterviewTimerService).syncFromServer(0, 900);
    await Promise.resolve();
    await Promise.resolve();

    expect(api.submitSession).toHaveBeenCalledTimes(1);
    expect(api.submitSession).toHaveBeenCalledWith('is_1', TOKEN);
  });

  it('a backend outage keeps the session locked and offers retry', async () => {
    render();
    api.submitSession.mockReturnValue(throwError(() => new InterviewApiError('BACKEND_UNAVAILABLE', 0)));

    await invokeSubmit();
    fixture.detectChanges();

    expect(component.submitError()).toBeTruthy();
    expect(router.navigate).not.toHaveBeenCalledWith(['/interview/results', 'is_1']);
    expect(TestBed.inject(InterviewSessionReferenceStorage).read()).not.toBeNull();
  });

  it('the result is held in memory only — never written to storage', async () => {
    render();
    api.submitSession.mockReturnValue(of({ sessionId: 'is_1', total: 3, correct: 2 }));
    await invokeSubmit();

    expect(JSON.stringify(localStorage)).not.toContain('correctOptionIds');
    const raw = sessionStorage.getItem('interviewSessionRef:v2') ?? '';
    expect(Object.keys(JSON.parse(raw)).sort())
      .toEqual(['currentIndex', 'sessionId', 'sessionToken', 'version']);
  });
});

describe('storage security during an active session', () => {
  it('only the minimal v2 reference is stored', () => {
    render(new Map([['rxjs:q:0', [101]]]));
    const raw = sessionStorage.getItem('interviewSessionRef:v2') ?? '';
    for (const banned of [
      'questions', 'options', 'answers', 'correct', 'correctOptionIds',
      'explanation', 'GeneratedAssessment', 'result', 'score', 'durationSeconds', 'expiresAt'
    ]) {
      expect(raw).not.toContain(banned);
    }
    expect(sessionStorage.getItem('interviewSession')).toBeNull();
  });
});

/**
 * "Try Again" after the backend was unreachable. The retry re-runs the resume,
 * and the answer may now be "this session is already over" — either submitted
 * (409 CONFLICT) or past its deadline and never finalized (409 SESSION_EXPIRED).
 * Neither may leave the user on the error card or, worse, on a permanent
 * "Preparing interview…": each is confirmed by the authenticated result and
 * forwarded to Results exactly once.
 */
describe('recovering a finished session from the retry state', () => {
  const finished = (): InterviewResultViewModel => ({
    sessionId: 'is_1',
    submittedAtMs: Date.parse('2026-08-01T12:00:00.000Z'),
    submittedByExpiry: false,
    total: 10, answered: 9, unanswered: 1, correct: 7, incorrect: 2, percentage: 70,
    durationSeconds: 900, timeUsedSeconds: 540,
    config: { mode: 'custom', difficulty: 'beginner', topicIds: ['rxjs'], questionCount: 10 },
    byTopic: [{ topicId: 'rxjs', title: 'RxJS', correct: 7, incorrect: 2, unanswered: 1, total: 10, percentage: 70 }],
    review: [{
      questionId: 'rxjs:q:0', sourceQuizId: 'rxjs', questionText: 'Q?', type: 'single',
      options: [{ optionId: 1, text: 'A' }, { optionId: 2, text: 'B' }],
      selectedOptionIds: [1], correctOptionIds: [1], explanation: 'Because.',
      isCorrect: true, isAnswered: true, flagged: false
    }]
  });

  const unreachable = () =>
    throwError(() => new InterviewApiError('BACKEND_UNAVAILABLE', 0));
  const conflict = () => throwError(() => new InterviewApiError('CONFLICT', 409));
  const expired = () => throwError(() => new InterviewApiError('SESSION_EXPIRED', 409));

  /** The guard let the component through in the error state (backend was down). */
  async function renderInErrorState(): Promise<void> {
    TestBed.inject(InterviewSessionReferenceStorage).write('is_1', TOKEN, 0);
    api.resumeSession.mockReturnValue(unreachable());
    backend = TestBed.inject(BackendInterviewSessionService);
    await backend.resumeFromStoredReference();

    fixture = TestBed.createComponent(InterviewSessionComponent);
    rendered = true;
    component = fixture.componentInstance;
    fixture.detectChanges();
    expect(backend.status()).toBe('error');
  }

  const text = () => fixture.nativeElement.textContent as string;

  it.each([
    ['submitted (CONFLICT)', conflict],
    ['expired and never finalized (SESSION_EXPIRED)', expired]
  ])('%s: confirmed by the result, then ONE navigation to Results for the right session', async (_label, resume) => {
    await renderInErrorState();
    api.resumeSession.mockReturnValue(resume());
    api.getResult.mockReturnValue(of(finished()));

    await component.retryResume();

    expect(router.navigate).toHaveBeenCalledTimes(1);
    expect(router.navigate).toHaveBeenCalledWith(['/interview/results', 'is_1']);
    expect(api.getResult).toHaveBeenCalledTimes(1);
    expect(component.retrying()).toBe(false);
  });

  it.each([
    ['a 409 from the result endpoint (the session is really still running)', () => conflict()],
    ['a 500', () => throwError(() => new InterviewApiError('BACKEND_UNAVAILABLE', 500))],
    ['a network failure', () => unreachable()]
  ])('an unconfirmed finish (%s): no navigation, and the retry card stays usable — never "Preparing…"', async (_label, resultError) => {
    await renderInErrorState();
    api.resumeSession.mockReturnValue(expired());
    api.getResult.mockReturnValue(resultError());

    await component.retryResume();
    fixture.detectChanges();

    expect(router.navigate).not.toHaveBeenCalled();
    expect(component.retrying()).toBe(false);
    expect(backend.status()).toBe('error');
    expect(fixture.nativeElement.querySelector('.interview-unavailable')).not.toBeNull();
    expect(text()).not.toContain('Preparing interview');
    // …and it can be retried again, once per click.
    api.resumeSession.mockClear();
    await component.retryResume();
    expect(api.resumeSession).toHaveBeenCalledTimes(1);
  });

  it('a dead credential found while confirming goes to the builder, not Results', async () => {
    await renderInErrorState();
    api.resumeSession.mockReturnValue(conflict());
    api.getResult.mockReturnValue(throwError(() => new InterviewApiError('UNAUTHORIZED', 401)));

    await component.retryResume();

    expect(router.navigate).toHaveBeenCalledTimes(1);
    expect(router.navigate).toHaveBeenCalledWith(['/interview']);
  });

  it('a double click sends ONE resume request and produces ONE navigation', async () => {
    await renderInErrorState();
    api.resumeSession.mockClear();
    api.resumeSession.mockReturnValue(expired());
    api.getResult.mockReturnValue(of(finished()));

    await Promise.all([component.retryResume(), component.retryResume()]);

    expect(api.resumeSession).toHaveBeenCalledTimes(1);
    expect(api.getResult).toHaveBeenCalledTimes(1);
    expect(router.navigate).toHaveBeenCalledTimes(1);
  });

  it('a component destroyed while the retry is in flight causes no late navigation', async () => {
    await renderInErrorState();
    const resume$ = new Subject<InterviewSessionViewModel>();
    api.resumeSession.mockReturnValue(resume$);
    api.getResult.mockReturnValue(of(finished()));

    const pending = component.retryResume();
    fixture.destroy();
    rendered = false;
    resume$.error(new InterviewApiError('CONFLICT', 409));
    await pending;

    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('an ACTIVE resume from the retry state just restarts the display timer: no result request, no navigation', async () => {
    await renderInErrorState();
    api.resumeSession.mockReturnValue(of(session()));

    await component.retryResume();

    expect(backend.status()).toBe('active');
    expect(api.getResult).not.toHaveBeenCalled();
    expect(router.navigate).not.toHaveBeenCalled();
  });

  /**
   * The retry card is ONE card with two truthful messages. "Cannot reach the
   * interview service" is right when the resume request failed; it is wrong when
   * the service answered and the interview's state is what could not be
   * confirmed. Wording is asserted as a literal on purpose — a copy change must
   * fail here rather than pass through a shared constant.
   */
  describe('retry card wording', () => {
    const UNCONFIRMED = 'We couldn’t confirm the status of this interview. Please try again.';
    const NETWORK = 'Cannot reach the interview service. Your assessment is safe — check your connection and try again.';

    const server500 = () => throwError(() => new InterviewApiError('BACKEND_UNAVAILABLE', 500));
    const notFound = () => throwError(() => new InterviewApiError('UNAUTHORIZED', 404));
    const unauthorized = () => throwError(() => new InterviewApiError('UNAUTHORIZED', 401));

    const settle = async (): Promise<void> => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      fixture.detectChanges();
    };
    const cardText = (): string =>
      (fixture.nativeElement.querySelector('.interview-unavailable__text')?.textContent ?? '')
        .replace(/\s+/g, ' ').trim();
    const card = (): HTMLElement | null => fixture.nativeElement.querySelector('.interview-unavailable');
    const tryAgain = (): HTMLButtonElement =>
      fixture.nativeElement.querySelector('.interview-unavailable .show-results-btn');

    /** What the user sees after the retry, given how the two calls answer. */
    async function retryWith(resume: () => unknown, result?: () => unknown): Promise<void> {
      await renderInErrorState();
      expect(cardText()).toBe(NETWORK);   // the starting point is a genuine outage
      api.resumeSession.mockReturnValue(resume());
      if (result) api.getResult.mockReturnValue(result());
      await component.retryResume();
      await settle();
    }

    describe.each([
      ['submitted (CONFLICT)', conflict],
      ['expired and never finalized (SESSION_EXPIRED)', expired]
    ])('resume says %s, but the result cannot confirm it', (_label, resume) => {
      it.each([
        ['result 500', server500],
        ['a network failure', unreachable],
        ['result 409 (still running — contradicts the resume)', conflict]
      ])('%s → the accurate "could not confirm" wording, not a connectivity claim', async (_l, result) => {
        await retryWith(resume, result);

        expect(cardText()).toBe(UNCONFIRMED);
        expect(fixture.nativeElement.textContent).not.toContain('Cannot reach the interview service');
        expect(fixture.nativeElement.textContent).not.toContain('Preparing interview');
        expect(router.navigate).not.toHaveBeenCalled();   // no false Results navigation
      });
    });

    it('screen readers get it through the card’s existing status semantics — one message, one live region', async () => {
      await retryWith(expired, server500);

      expect(card()?.getAttribute('role')).toBe('status');
      expect(card()?.getAttribute('aria-live')).toBe('polite');
      const messages = card()?.querySelectorAll('.interview-unavailable__text') ?? [];
      expect(messages.length).toBe(1);   // never both messages at once
      expect(card()?.contains(messages[0])).toBe(true);
    });

    it('is also what the FIRST paint shows when the guard let the component through unconfirmed', async () => {
      TestBed.inject(InterviewSessionReferenceStorage).write('is_1', TOKEN, 0);
      api.resumeSession.mockReturnValue(expired());
      backend = TestBed.inject(BackendInterviewSessionService);
      await backend.resumeFromStoredReference();
      backend.markResumeUnresolved();   // what BackendInterviewResultService.confirmFinished does

      fixture = TestBed.createComponent(InterviewSessionComponent);
      rendered = true;
      component = fixture.componentInstance;
      fixture.detectChanges();

      expect(cardText()).toBe(UNCONFIRMED);
    });

    it('the Try Again button is wired to exactly one retry per click', async () => {
      await retryWith(expired, server500);
      // Spied rather than executed: a click runs inside Angular's zone, where a
      // mocked throw-on-subscribe would be reported as an unhandled exception by
      // the test environment alone. The attempts themselves are exercised below.
      const retry = jest.spyOn(component, 'retryResume').mockResolvedValue();

      tryAgain().click();
      expect(retry).toHaveBeenCalledTimes(1);
      tryAgain().click();
      expect(retry).toHaveBeenCalledTimes(2);
    });

    it('Retry stays available and BOUNDED: one attempt is exactly one resume + one confirmation, and nothing repeats on its own', async () => {
      await retryWith(expired, server500);
      const resumeBefore = api.resumeSession.mock.calls.length;
      const resultBefore = api.getResult.mock.calls.length;
      expect(tryAgain().textContent?.trim()).toBe('Try Again');
      expect(tryAgain().disabled).toBe(false);

      // Nothing polls: idle time adds no requests.
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(api.resumeSession.mock.calls.length).toBe(resumeBefore);
      expect(api.getResult.mock.calls.length).toBe(resultBefore);

      // Each click is exactly one attempt, and the card comes back each time.
      for (let click = 1; click <= 3; click++) {
        await component.retryResume();
        await settle();
        expect(api.resumeSession.mock.calls.length).toBe(resumeBefore + click);
        expect(api.getResult.mock.calls.length).toBe(resultBefore + click);
        expect(cardText()).toBe(UNCONFIRMED);
        expect(tryAgain().disabled).toBe(false);
      }
      expect(router.navigate).not.toHaveBeenCalled();
      expect(TestBed.inject(InterviewSessionReferenceStorage).read()?.sessionId).toBe('is_1');   // credentials kept
    });

    describe('a genuine connectivity failure keeps its own wording', () => {
      it.each([
        ['a network failure on the resume', unreachable],
        ['a 500 on the resume', server500]
      ])('%s', async (_l, resume) => {
        await retryWith(resume);

        expect(cardText()).toBe(NETWORK);
        expect(cardText()).not.toBe(UNCONFIRMED);
        expect(api.getResult).not.toHaveBeenCalled();   // nothing finished was claimed, nothing to confirm
        expect(router.navigate).not.toHaveBeenCalled();
      });

      it('the wording follows the LATEST failure in both directions — no stale message', async () => {
        await retryWith(expired, server500);
        expect(cardText()).toBe(UNCONFIRMED);

        api.resumeSession.mockReturnValue(unreachable());
        await component.retryResume();
        await settle();
        expect(cardText()).toBe(NETWORK);

        api.resumeSession.mockReturnValue(conflict());
        api.getResult.mockReturnValue(server500());
        await component.retryResume();
        await settle();
        expect(cardText()).toBe(UNCONFIRMED);
      });
    });

    describe('credential / session failures keep their safe redirect', () => {
      it('a resume 401 goes to the builder, never probes the result, and never shows the unconfirmed wording', async () => {
        await retryWith(unauthorized);

        expect(router.navigate).toHaveBeenCalledTimes(1);
        expect(router.navigate).toHaveBeenCalledWith(['/interview']);
        expect(api.getResult).not.toHaveBeenCalled();
        expect(fixture.nativeElement.textContent).not.toContain(UNCONFIRMED);
      });

      it.each([
        ['401 (invalid token)', unauthorized],
        ['404 (unknown session)', notFound]
      ])('confirming with the result and getting a %s goes to the builder, not Results', async (_l, result) => {
        await retryWith(expired, result);

        expect(router.navigate).toHaveBeenCalledTimes(1);
        expect(router.navigate).toHaveBeenCalledWith(['/interview']);
        expect(fixture.nativeElement.textContent).not.toContain(UNCONFIRMED);
        expect(TestBed.inject(InterviewSessionReferenceStorage).read()).toBeNull();   // dead credential cleared, as before
      });
    });

    it.each([
      ['submitted (CONFLICT)', conflict],
      ['expired and never finalized (SESSION_EXPIRED)', expired]
    ])('a CONFIRMED %s navigates to Results once and never shows the error', async (_l, resume) => {
      await retryWith(resume, () => of(finished()));

      expect(router.navigate).toHaveBeenCalledTimes(1);
      expect(router.navigate).toHaveBeenCalledWith(['/interview/results', 'is_1']);
      expect(card()).toBeNull();
      expect(fixture.nativeElement.textContent).not.toContain(UNCONFIRMED);
      expect(fixture.nativeElement.textContent).not.toContain('Cannot reach the interview service');
    });

    it('an ACTIVE resume renders the assessment and never shows either message', async () => {
      await retryWith(() => of(session()));

      expect(backend.status()).toBe('active');
      expect(card()).toBeNull();
      expect(fixture.nativeElement.querySelector('.interview-question')?.textContent).toContain('Which answer is correct?');
      expect(fixture.nativeElement.textContent).not.toContain(UNCONFIRMED);
      expect(fixture.nativeElement.textContent).not.toContain('Cannot reach the interview service');
      expect(api.getResult).not.toHaveBeenCalled();
      expect(router.navigate).not.toHaveBeenCalled();
    });
  });
});
