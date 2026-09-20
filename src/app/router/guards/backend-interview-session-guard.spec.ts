import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, convertToParamMap, type ActivatedRouteSnapshot } from '@angular/router';
import { of, throwError } from 'rxjs';

import { BackendInterviewSessionGuard } from './backend-interview-session-guard';
import { BackendInterviewResultGuard } from './backend-interview-result-guard';
import { BackendInterviewResultService } from '../../shared/services/interview/backend-interview-result.service';
import { BackendInterviewSessionService } from '../../shared/services/interview/backend-interview-session.service';
import { InterviewSessionReferenceStorage } from '../../shared/services/interview/interview-session-reference.storage';
import { InterviewHistoryService } from '../../shared/services/features/interview/interview-history.service';
import { InterviewApiService } from '../../shared/services/api/interview-api.service';
import {
  InterviewApiError,
  type InterviewApiErrorCode
} from '../../shared/services/api/interview-api.errors';
import { SK_INTERVIEW_SESSION_REF } from '../../shared/models/interview/interview-session-reference.model';
import type {
  InterviewResultViewModel,
  InterviewSessionViewModel
} from '../../shared/models/interview/interview-view-models';

/**
 * The guard is the ONLY hydration path for `/interview/session/:sessionId`, so
 * these cases decide what the user sees for every backend state.
 *
 * Only an unreachable backend ALLOWS the component through (it offers a retry;
 * redirecting on an outage would throw away a live assessment over a dropped
 * connection). A session the resume call reports as submitted OR expired is
 * never taken on trust: the authenticated result endpoint must confirm it
 * before anything navigates to Results, and anything it cannot confirm ends in
 * a stable error state rather than a redirect loop or an endless spinner.
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

/** A valid frozen result (the shared pipeline records history from it, so it must be complete). */
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

let guard: BackendInterviewSessionGuard;
let storage: InterviewSessionReferenceStorage;
let router: Router;
let api: { resumeSession: jest.Mock; getResult: jest.Mock };

const snapshot = (sessionId: string) =>
  ({ paramMap: convertToParamMap({ sessionId }) } as unknown as ActivatedRouteSnapshot);

const run = (sessionId = 'is_1') => guard.canActivate(snapshot(sessionId));

const fails = (code: InterviewApiErrorCode, status: number) =>
  api.resumeSession.mockReturnValue(throwError(() => new InterviewApiError(code, status)));

/** The authenticated result endpoint's answer for the session under test. */
const resultIs = (value: InterviewResultViewModel) => api.getResult.mockReturnValue(of(value));
const resultFails = (code: InterviewApiErrorCode, status: number) =>
  api.getResult.mockReturnValue(throwError(() => new InterviewApiError(code, status)));

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  api = { resumeSession: jest.fn(), getResult: jest.fn() };

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      BackendInterviewSessionService,
      BackendInterviewResultService,
      InterviewSessionReferenceStorage,
      InterviewHistoryService,
      { provide: InterviewApiService, useValue: api }
    ]
  });

  guard = TestBed.inject(BackendInterviewSessionGuard);
  storage = TestBed.inject(InterviewSessionReferenceStorage);
  router = TestBed.inject(Router);
});
afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

const url = (result: unknown) => router.serializeUrl(result as never);

it('ACTIVE: allows, hydrates once, and never asks the backend twice', async () => {
  storage.write('is_1', TOKEN, 0);
  api.resumeSession.mockReturnValue(of(SESSION));

  expect(await run()).toBe(true);
  expect(api.resumeSession).toHaveBeenCalledTimes(1);
  expect(api.resumeSession).toHaveBeenCalledWith('is_1', TOKEN);
  // An active session has no result: it must never be requested, or results
  // would be reachable (or at least probed) before submission.
  expect(api.getResult).not.toHaveBeenCalled();

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
  // No token, so no unauthenticated result probe either.
  expect(api.getResult).not.toHaveBeenCalled();
});

it('MISMATCHED id: redirects and KEEPS the reference — it may belong to another tab', async () => {
  storage.write('is_1', TOKEN, 0);

  expect(url(await run('is_other'))).toBe('/interview');
  expect(api.resumeSession).not.toHaveBeenCalled();
  expect(storage.read()?.sessionId).toBe('is_1');
});

// ── finished sessions: the resume call only SUGGESTS "finished"; the ─────────
// ── authenticated result endpoint PROVES it before anything navigates ────────
//
// Two different 409s reach here (CONFLICT = already submitted, SESSION_EXPIRED
// = deadline passed but never finalized). The result endpoint finalizes an
// expired session and returns 200 for a submitted one, and answers 409 while a
// session is genuinely still running — so it cannot confirm a false claim.

describe.each([
  ['SUBMITTED (resume CONFLICT)', 'CONFLICT'],
  ['EXPIRED, never finalized (resume SESSION_EXPIRED)', 'SESSION_EXPIRED']
] as const)('%s', (_label, resumeCode) => {
  beforeEach(() => storage.write('is_1', TOKEN, 0));

  it('is confirmed by the authenticated result, then redirects to Results exactly once', async () => {
    fails(resumeCode, 409);
    resultIs(result());

    // The id is in the path; the token never is.
    expect(url(await run())).toBe('/interview/results/is_1');
    expect(api.resumeSession).toHaveBeenCalledTimes(1);
    expect(api.getResult).toHaveBeenCalledTimes(1);
    expect(api.getResult).toHaveBeenCalledWith('is_1', TOKEN);
  });

  it('the Results guard that follows re-uses the proven result — no second GET /result', async () => {
    fails(resumeCode, 409);
    resultIs(result());
    await run();

    const resultsGuard = TestBed.inject(BackendInterviewResultGuard);
    expect(await resultsGuard.canActivate(snapshot('is_1'))).toBe(true);
    expect(api.getResult).toHaveBeenCalledTimes(1);
  });

  it('never blocks on "Preparing…": the session status is terminal, not loading', async () => {
    fails(resumeCode, 409);
    resultIs(result());
    await run();

    expect(TestBed.inject(BackendInterviewSessionService).loading()).toBe(false);
  });

  it('the token stays in memory/storage only — never in the redirect URL', async () => {
    fails(resumeCode, 409);
    resultIs(result());

    expect(url(await run())).not.toContain(TOKEN);
  });

  describe('when the result lookup CANNOT confirm it', () => {
    it('a 409 from the result endpoint (still running) is NOT treated as submitted: no redirect, stable error state', async () => {
      fails(resumeCode, 409);
      resultFails('CONFLICT', 409);

      expect(await run()).toBe(true);   // component renders its own error state
      const session = TestBed.inject(BackendInterviewSessionService);
      expect(session.status()).toBe('error');
      expect(session.loading()).toBe(false);
      // The service ANSWERED; the interview's state is what is unknown — so the
      // card must not say the service cannot be reached.
      expect(session.errorReason()).toBe('unconfirmed');
      expect(api.getResult).toHaveBeenCalledTimes(1);   // no ping-pong with the Results guard
      expect(storage.read()?.sessionId).toBe('is_1');   // the live reference survives
    });

    it.each([
      ['500', 'BACKEND_UNAVAILABLE', 500],
      ['network failure', 'BACKEND_UNAVAILABLE', 0]
    ] as const)('%s: stable error state with retry, reference preserved, no navigation', async (_l, code, status) => {
      fails(resumeCode, 409);
      resultFails(code, status);

      expect(await run()).toBe(true);
      const session = TestBed.inject(BackendInterviewSessionService);
      expect(session.status()).toBe('error');
      expect(session.errorReason()).toBe('unconfirmed');
      expect(session.loading()).toBe(false);
      expect(storage.read()?.sessionId).toBe('is_1');
    });

    it.each([
      ['401 invalid token', 'UNAUTHORIZED', 401],
      ['404 unknown session', 'UNAUTHORIZED', 404]
    ] as const)('%s: dead reference cleared and sent to the builder — never to Results', async (_l, code, status) => {
      fails(resumeCode, 409);
      resultFails(code, status);

      expect(url(await run())).toBe('/interview');
      expect(storage.read()).toBeNull();
    });

    it('a response that is not a result at all (malformed) is not rendered as one', async () => {
      fails(resumeCode, 409);
      api.getResult.mockReturnValue(of({ sessionId: '' } as unknown as InterviewResultViewModel));

      expect(await run()).toBe(true);
      const session = TestBed.inject(BackendInterviewSessionService);
      expect(session.status()).toBe('error');
      expect(session.errorReason()).toBe('unconfirmed');
    });
  });

  it('two overlapping activations of the same URL cause ONE resume and ONE result request', async () => {
    fails(resumeCode, 409);
    resultIs(result());

    const [first, second] = await Promise.all([run(), run()]);

    expect(url(first)).toBe('/interview/results/is_1');
    expect(url(second)).toBe('/interview/results/is_1');
    expect(api.resumeSession).toHaveBeenCalledTimes(1);
    expect(api.getResult).toHaveBeenCalledTimes(1);
  });
});

it('a resume 401 never probes the result endpoint (no credentials, no probe)', async () => {
  storage.write('is_1', TOKEN, 0);
  fails('UNAUTHORIZED', 401);

  expect(url(await run())).toBe('/interview');
  expect(api.getResult).not.toHaveBeenCalled();
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
  const session = TestBed.inject(BackendInterviewSessionService);
  expect(session.status()).toBe('error');
  // A genuine outage keeps its connectivity wording: the resume itself failed,
  // so this is NOT the "could not confirm the interview's status" case.
  expect(session.errorReason()).toBe('unreachable');
  expect(storage.read()?.sessionId).toBe('is_1');
  expect(api.getResult).not.toHaveBeenCalled();   // nothing finished was claimed, nothing to confirm
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
