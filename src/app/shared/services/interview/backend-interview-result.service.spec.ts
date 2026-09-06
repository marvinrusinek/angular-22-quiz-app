import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, convertToParamMap, type ActivatedRouteSnapshot } from '@angular/router';
import { of, throwError } from 'rxjs';

import { BackendInterviewResultService } from './backend-interview-result.service';
import { BackendInterviewSessionService } from './backend-interview-session.service';
import { InterviewSessionReferenceStorage } from './interview-session-reference.storage';
import { BackendInterviewResultGuard } from '../../../router/guards/backend-interview-result-guard';
import { InterviewApiService } from '../api/interview-api.service';
import { InterviewApiError, type InterviewApiErrorCode } from '../api/interview-api.errors';
import { InterviewHistoryService } from '../features/interview/interview-history.service';
import { SK_INTERVIEW_HISTORY } from '../../constants/session-keys';
import type { InterviewResultViewModel } from '../../models/interview/interview-view-models';

/**
 * ONE result-loading pipeline, shared by the guard and the Results page, so a
 * navigation issues exactly one GET /result. Nothing here scores anything: a
 * backend that cannot be reached produces a retryable state, never a locally
 * computed fallback.
 */
const TOKEN = 'a'.repeat(43);

function result(over: Partial<InterviewResultViewModel> = {}): InterviewResultViewModel {
  return {
    sessionId: 'is_1',
    submittedAtMs: Date.parse('2026-08-01T12:00:00.000Z'),
    submittedByExpiry: false,
    total: 10, answered: 9, unanswered: 1, correct: 7, incorrect: 2, percentage: 70,
    durationSeconds: 900, timeUsedSeconds: 540,
    config: { mode: 'custom', difficulty: 'beginner', topicIds: ['rxjs'], questionCount: 10 },
    byTopic: [
      { topicId: 'rxjs', title: 'RxJS', correct: 7, incorrect: 2, unanswered: 1, total: 10, percentage: 70 }
    ],
    review: [{
      questionId: 'rxjs:q:0', sourceQuizId: 'rxjs', questionText: 'Q?', type: 'single',
      options: [{ optionId: 1, text: 'A' }, { optionId: 2, text: 'B' }],
      selectedOptionIds: [1], correctOptionIds: [1], explanation: 'Because.',
      isCorrect: true, isAnswered: true, flagged: false
    }],
    ...over
  };
}

let service: BackendInterviewResultService;
let guard: BackendInterviewResultGuard;
let storage: InterviewSessionReferenceStorage;
let history: InterviewHistoryService;
let router: Router;
let api: { getResult: jest.Mock; submitSession: jest.Mock; resumeSession: jest.Mock; saveAnswer: jest.Mock };

const fails = (code: InterviewApiErrorCode, status: number) =>
  api.getResult.mockReturnValue(throwError(() => new InterviewApiError(code, status)));

const snapshot = (sessionId: string) =>
  ({ paramMap: convertToParamMap({ sessionId }) } as unknown as ActivatedRouteSnapshot);

const url = (value: unknown) => router.serializeUrl(value as never);

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  api = { getResult: jest.fn(), submitSession: jest.fn(), resumeSession: jest.fn(), saveAnswer: jest.fn() };

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      BackendInterviewResultService,
      BackendInterviewSessionService,
      InterviewSessionReferenceStorage,
      InterviewHistoryService,
      { provide: InterviewApiService, useValue: api }
    ]
  });

  service = TestBed.inject(BackendInterviewResultService);
  guard = TestBed.inject(BackendInterviewResultGuard);
  storage = TestBed.inject(InterviewSessionReferenceStorage);
  history = TestBed.inject(InterviewHistoryService);
  router = TestBed.inject(Router);
});
afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

describe('loading', () => {
  it('fetches with the stored token and hydrates the result', async () => {
    storage.write('is_1', TOKEN, 0);
    api.getResult.mockReturnValue(of(result()));

    const outcome = await service.load('is_1');

    expect(outcome.kind).toBe('loaded');
    expect(api.getResult).toHaveBeenCalledWith('is_1', TOKEN);
    expect(service.result()?.percentage).toBe(70);
    expect(service.hasResult()).toBe(true);
  });

  it('reuses the ALREADY-LOADED result instead of re-fetching', async () => {
    storage.write('is_1', TOKEN, 0);
    api.getResult.mockReturnValue(of(result()));

    await service.load('is_1');
    await service.load('is_1');
    await service.load('is_1');

    expect(api.getResult).toHaveBeenCalledTimes(1);
  });

  it('adopts the in-memory result from a just-completed submit without a request', async () => {
    storage.write('is_1', TOKEN, 0);
    api.submitSession.mockReturnValue(of(result()));

    // Drive a real submit so the session service is holding the response.
    const session = TestBed.inject(BackendInterviewSessionService);
    session.activateCreatedSession({
      sessionId: 'is_1', status: 'active', createdAtMs: 0, expiresAtMs: 0,
      durationSeconds: 900, remainingSeconds: 900,
      config: { mode: 'custom', topicIds: ['rxjs'], questionCount: 1 },
      questions: [], answers: new Map(), flags: new Map()
    }, TOKEN);
    await session.submit();

    const outcome = await service.load('is_1');

    expect(outcome.kind).toBe('loaded');
    expect(api.getResult).not.toHaveBeenCalled();   // submit already returned it
  });

  it('a NEW session does not inherit the previous attempt result', async () => {
    // Otherwise submit() short-circuits and returns the old result, and the
    // results route is asked for a session the backend still calls active.
    const session = TestBed.inject(BackendInterviewSessionService);
    const activate = (sessionId: string) => session.activateCreatedSession({
      sessionId, status: 'active', createdAtMs: 0, expiresAtMs: 0,
      durationSeconds: 900, remainingSeconds: 900,
      config: { mode: 'custom', topicIds: ['rxjs'], questionCount: 1 },
      questions: [], answers: new Map(), flags: new Map()
    }, TOKEN);

    api.submitSession.mockReturnValue(of(result({ sessionId: 'is_1' })));
    activate('is_1');
    await session.submit();
    expect(session.result()?.sessionId).toBe('is_1');

    activate('is_2');
    expect(session.result()).toBeNull();

    api.submitSession.mockReturnValue(of(result({ sessionId: 'is_2' })));
    await session.submit();
    expect(session.result()?.sessionId).toBe('is_2');
    expect(api.submitSession).toHaveBeenCalledTimes(2);
  });

  it('does NOT fetch when the route id and the stored reference disagree', async () => {
    storage.write('is_1', TOKEN, 0);

    expect((await service.load('is_other')).kind).toBe('none');
    expect(api.getResult).not.toHaveBeenCalled();
  });

  it('reports "none" with no reference at all', async () => {
    expect((await service.load('is_1')).kind).toBe('none');
    expect(api.getResult).not.toHaveBeenCalled();
  });
});

describe('error handling', () => {
  beforeEach(() => storage.write('is_1', TOKEN, 0));

  it('UNAUTHORIZED clears the invalid reference', async () => {
    fails('UNAUTHORIZED', 401);
    expect((await service.load('is_1')).kind).toBe('unauthorized');
    expect(storage.read()).toBeNull();
  });

  it('CONFLICT means the assessment is still running', async () => {
    fails('CONFLICT', 409);
    expect((await service.load('is_1')).kind).toBe('not-ready');
    // Still usable — the user can go back and finish.
    expect(storage.read()).not.toBeNull();
  });

  it('an outage KEEPS the reference so a retry can succeed', async () => {
    fails('BACKEND_UNAVAILABLE', 0);
    expect((await service.load('is_1')).kind).toBe('unavailable');
    expect(storage.read()?.sessionId).toBe('is_1');
    expect(service.result()).toBeNull();   // never a local fallback

    api.getResult.mockReturnValue(of(result()));
    expect((await service.reload('is_1')).kind).toBe('loaded');
    expect(service.result()?.percentage).toBe(70);
  });

  it('a malformed response is rejected rather than rendered', async () => {
    api.getResult.mockReturnValue(of({ sessionId: '', total: NaN } as never));
    expect((await service.load('is_1')).kind).toBe('malformed');
    expect(service.result()).toBeNull();
  });

  it('never writes history for a failed load', async () => {
    fails('BACKEND_UNAVAILABLE', 0);
    await service.load('is_1');
    expect(history.history()).toHaveLength(0);
  });
});

describe('history recording', () => {
  beforeEach(() => storage.write('is_1', TOKEN, 0));

  it('records ONE sanitized attempt however many times the result is loaded', async () => {
    api.getResult.mockReturnValue(of(result()));

    await service.load('is_1');      // navigate
    service.clear();
    await service.load('is_1');      // refresh
    service.clear();
    await service.load('is_1');      // remount
    await service.reload('is_1');    // explicit retry

    expect(api.getResult).toHaveBeenCalledTimes(3);
    expect(history.history()).toHaveLength(1);
    expect(history.history()[0]!.sessionId).toBe('is_1');
  });

  it('stores no review data in localStorage', async () => {
    api.getResult.mockReturnValue(of(result()));
    await service.load('is_1');

    const raw = localStorage.getItem(SK_INTERVIEW_HISTORY) ?? '';
    for (const banned of ['review', 'explanation', 'correctOptionIds', 'Because.', 'options']) {
      expect(raw).not.toContain(banned);
    }
  });

  it('keeps the complete result in memory only', async () => {
    api.getResult.mockReturnValue(of(result()));
    await service.load('is_1');

    expect(service.result()!.review).toHaveLength(1);          // in memory
    expect(JSON.stringify(localStorage)).not.toContain('Because.');
    expect(JSON.stringify(sessionStorage)).not.toContain('Because.');
  });
});

describe('guard', () => {
  it('allows a valid submitted result', async () => {
    storage.write('is_1', TOKEN, 0);
    api.getResult.mockReturnValue(of(result()));

    expect(await guard.canActivate(snapshot('is_1'))).toBe(true);
    // The component reads what the guard loaded — no second request.
    expect(api.getResult).toHaveBeenCalledTimes(1);
  });

  it('sends an unsubmitted assessment back to its session', async () => {
    storage.write('is_1', TOKEN, 0);
    fails('CONFLICT', 409);

    expect(url(await guard.canActivate(snapshot('is_1')))).toBe('/interview/session/is_1');
  });

  it('redirects to the builder with no reference or a mismatched id', async () => {
    expect(url(await guard.canActivate(snapshot('is_1')))).toBe('/interview');

    storage.write('is_1', TOKEN, 0);
    expect(url(await guard.canActivate(snapshot('is_other')))).toBe('/interview');
  });

  it('redirects to the builder when the reference is unauthorized', async () => {
    storage.write('is_1', TOKEN, 0);
    fails('UNAUTHORIZED', 401);

    expect(url(await guard.canActivate(snapshot('is_1')))).toBe('/interview');
  });

  it('ALLOWS an outage through so the page can offer a retry', async () => {
    storage.write('is_1', TOKEN, 0);
    fails('BACKEND_UNAVAILABLE', 0);

    expect(await guard.canActivate(snapshot('is_1'))).toBe(true);
    expect(storage.read()).not.toBeNull();
  });

  it('never puts the token in a redirect URL', async () => {
    storage.write('is_1', TOKEN, 0);
    fails('UNAUTHORIZED', 401);

    expect(url(await guard.canActivate(snapshot('is_1')))).not.toContain(TOKEN);
  });
});
