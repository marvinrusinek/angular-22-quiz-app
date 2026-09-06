import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, convertToParamMap, type ActivatedRouteSnapshot } from '@angular/router';
import { of, throwError } from 'rxjs';

import { BackendInterviewSessionGuard } from './backend-interview-session-guard';
import { BackendInterviewSessionService } from '../../shared/services/interview/backend-interview-session.service';
import { InterviewSessionReferenceStorage } from '../../shared/services/interview/interview-session-reference.storage';
import { InterviewApiService } from '../../shared/services/api/interview-api.service';
import {
  InterviewApiError,
  type InterviewApiErrorCode
} from '../../shared/services/api/interview-api.errors';
import { SK_INTERVIEW_SESSION_REF } from '../../shared/models/interview/interview-session-reference.model';
import type { InterviewSessionViewModel } from '../../shared/models/interview/interview-view-models';

/**
 * The guard is the ONLY hydration path for `/interview/session/:sessionId`, so
 * these cases decide what the user sees for every backend state.
 *
 * Two outcomes deliberately ALLOW rather than redirect: an expired session
 * (the component finalizes it) and an unreachable backend (the component
 * offers a retry). Redirecting on an outage would throw away a live assessment
 * over a dropped connection.
 */
const TOKEN = 'a'.repeat(43);

const SESSION: InterviewSessionViewModel = {
  sessionId: 'is_1', status: 'active',
  createdAtMs: 1_700_000_000_000, expiresAtMs: 1_700_000_900_000,
  durationSeconds: 900, remainingSeconds: 640,
  config: { mode: 'custom', topicIds: ['rxjs'], questionCount: 1 },
  questions: [{
    questionId: 'rxjs:q:0', sourceQuizId: 'rxjs',
    questionText: 'Q', type: 'single',
    options: [{ optionId: 101, text: 'A' }]
  }],
  answers: new Map(),
  flags: new Map()
};

let guard: BackendInterviewSessionGuard;
let storage: InterviewSessionReferenceStorage;
let router: Router;
let api: { resumeSession: jest.Mock };

const snapshot = (sessionId: string) =>
  ({ paramMap: convertToParamMap({ sessionId }) } as unknown as ActivatedRouteSnapshot);

const run = (sessionId = 'is_1') => guard.canActivate(snapshot(sessionId));

const fails = (code: InterviewApiErrorCode, status: number) =>
  api.resumeSession.mockReturnValue(throwError(() => new InterviewApiError(code, status)));

beforeEach(() => {
  sessionStorage.clear();
  api = { resumeSession: jest.fn() };

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      BackendInterviewSessionService,
      InterviewSessionReferenceStorage,
      { provide: InterviewApiService, useValue: api }
    ]
  });

  guard = TestBed.inject(BackendInterviewSessionGuard);
  storage = TestBed.inject(InterviewSessionReferenceStorage);
  router = TestBed.inject(Router);
});
afterEach(() => sessionStorage.clear());

const url = (result: unknown) => router.serializeUrl(result as never);

it('ACTIVE: allows, hydrates once, and never asks the backend twice', async () => {
  storage.write('is_1', TOKEN, 0);
  api.resumeSession.mockReturnValue(of(SESSION));

  expect(await run()).toBe(true);
  expect(api.resumeSession).toHaveBeenCalledTimes(1);
  expect(api.resumeSession).toHaveBeenCalledWith('is_1', TOKEN);

  const session = TestBed.inject(BackendInterviewSessionService);
  expect(session.status()).toBe('active');
  expect(session.questionCount()).toBe(1);
  // The server's own remaining time, not a fresh full duration.
  expect(session.serverRemainingSeconds()).toBe(640);
});

it('restores the stored question position', async () => {
  storage.write('is_1', TOKEN, 0);
  api.resumeSession.mockReturnValue(of({
    ...SESSION,
    questions: [SESSION.questions[0]!, { ...SESSION.questions[0]!, questionId: 'rxjs:q:1' }]
  }));
  storage.write('is_1', TOKEN, 1);

  await run();
  expect(TestBed.inject(BackendInterviewSessionService).currentIndex()).toBe(1);
});

it('NO REFERENCE: redirects to the builder without calling the backend', async () => {
  expect(url(await run())).toBe('/interview');
  expect(api.resumeSession).not.toHaveBeenCalled();
});

it('MISMATCHED id: redirects and KEEPS the reference — it may belong to another tab', async () => {
  storage.write('is_1', TOKEN, 0);

  expect(url(await run('is_other'))).toBe('/interview');
  expect(api.resumeSession).not.toHaveBeenCalled();
  expect(storage.read()?.sessionId).toBe('is_1');
});

it('SUBMITTED: redirects to the results route for THIS session', async () => {
  storage.write('is_1', TOKEN, 0);
  fails('CONFLICT', 409);

  // The id is in the path; the token never is.
  expect(url(await run())).toBe('/interview/results/is_1');
});

it('EXPIRED: allows so the component can finalize', async () => {
  storage.write('is_1', TOKEN, 0);
  fails('SESSION_EXPIRED', 409);

  expect(await run()).toBe(true);
  expect(TestBed.inject(BackendInterviewSessionService).status()).toBe('expired');
});

it('UNAUTHORIZED: redirects and clears the dead reference', async () => {
  storage.write('is_1', TOKEN, 0);
  fails('UNAUTHORIZED', 401);

  expect(url(await run())).toBe('/interview');
  expect(storage.read()).toBeNull();
});

it('BACKEND UNREACHABLE: allows the retry state and PRESERVES the reference', async () => {
  storage.write('is_1', TOKEN, 0);
  fails('BACKEND_UNAVAILABLE', 0);

  expect(await run()).toBe(true);
  expect(TestBed.inject(BackendInterviewSessionService).status()).toBe('error');
  expect(storage.read()?.sessionId).toBe('is_1');
});

it('a MALFORMED reference is treated as absent and removed', async () => {
  sessionStorage.setItem(SK_INTERVIEW_SESSION_REF, '{ not json');

  expect(url(await run())).toBe('/interview');
  expect(sessionStorage.getItem(SK_INTERVIEW_SESSION_REF)).toBeNull();
  expect(api.resumeSession).not.toHaveBeenCalled();
});

it('a reference carrying answer-bearing fields is rejected outright', async () => {
  sessionStorage.setItem(SK_INTERVIEW_SESSION_REF, JSON.stringify({
    version: 2, sessionId: 'is_1', sessionToken: TOKEN, currentIndex: 0,
    correctOptionIds: [101]
  }));

  expect(url(await run())).toBe('/interview');
  expect(api.resumeSession).not.toHaveBeenCalled();
});

it('never puts the token in the redirect URL', async () => {
  storage.write('is_1', TOKEN, 0);
  fails('UNAUTHORIZED', 401);

  expect(url(await run())).not.toContain(TOKEN);
});
