import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, type Routes } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { of, Subject, throwError } from 'rxjs';

import { routes } from '../quiz-routing.routes';
import { BackendInterviewSessionGuard } from './backend-interview-session-guard';
import { BackendInterviewResultGuard } from './backend-interview-result-guard';
import { InterviewSessionComponent } from '../../containers/interview/interview-session/interview-session.component';
import { BackendInterviewSessionService } from '@shared/services/interview/backend-interview-session.service';
import { BackendInterviewResultService } from '@shared/services/interview/backend-interview-result.service';
import { BackendInterviewTimerService } from '@shared/services/interview/backend-interview-timer.service';
import { InterviewSessionReferenceStorage } from '@shared/services/interview/interview-session-reference.storage';
import { InterviewHistoryService } from '@shared/services/features/interview/interview-history.service';
import { InterviewApiService } from '@shared/services/api/interview-api.service';
import { InterviewApiError, type InterviewApiErrorCode } from '@shared/services/api/interview-api.errors';
import type {
  InterviewResultViewModel,
  InterviewSessionViewModel
} from '@shared/models/interview/interview-view-models';

/**
 * Can `InterviewSessionComponent` ever be CREATED while the session is already
 * over (`submitted` / `expired`)?
 *
 * The component's `ngOnInit` once carried a branch for exactly that. This spec
 * answers the question against the REAL route configuration, the REAL guards and
 * the REAL session / result services — only the HTTP layer is faked — by
 * recording the session status at the instant the component's `ngOnInit` runs,
 * across every way of getting to `/interview/session/:sessionId`.
 *
 * It is deliberately kept after the branch was removed: if a routing change
 * (a resolver, a lazy component, a guard that lets a finished session through)
 * ever lets a finished session reach the component again, this fails loudly
 * instead of leaving a locked, half-rendered assessment on screen.
 */
const TOKEN = 'a'.repeat(43);
const SESSION_URL = '/interview/session/is_1';
const RESULTS_URL = '/interview/results/is_1';

const SESSION: InterviewSessionViewModel = {
  sessionId: 'is_1', status: 'active',
  createdAtMs: 1_700_000_000_000, expiresAtMs: 1_700_000_900_000,
  durationSeconds: 900, remainingSeconds: 900,
  config: { mode: 'custom', difficulty: 'mixed', topicIds: ['rxjs'], questionCount: 1 },
  questions: [{
    questionId: 'rxjs:q:0', sourceQuizId: 'rxjs', questionText: 'Which answer is correct?',
    type: 'single', options: [{ optionId: 101, text: 'A' }, { optionId: 102, text: 'B' }]
  }],
  answers: new Map(),
  flags: new Map()
};

function result(over: Partial<InterviewResultViewModel> = {}): InterviewResultViewModel {
  return {
    sessionId: 'is_1',
    submittedAtMs: Date.parse('2026-08-01T12:00:00.000Z'),
    submittedByExpiry: false,
    total: 1, answered: 1, unanswered: 0, correct: 1, incorrect: 0, percentage: 100,
    durationSeconds: 900, timeUsedSeconds: 540,
    config: { mode: 'custom', difficulty: 'beginner', topicIds: ['rxjs'], questionCount: 1 },
    byTopic: [
      { topicId: 'rxjs', title: 'RxJS', correct: 1, incorrect: 0, unanswered: 0, total: 1, percentage: 100 }
    ],
    review: [{
      questionId: 'rxjs:q:0', sourceQuizId: 'rxjs', questionText: 'Q?', type: 'single',
      options: [{ optionId: 101, text: 'A' }, { optionId: 102, text: 'B' }],
      selectedOptionIds: [101], correctOptionIds: [101], explanation: 'Because.',
      isCorrect: true, isAnswered: true, flagged: false
    }],
    ...over
  };
}

@Component({ selector: 'codelab-lifecycle-builder-stub', template: '' })
class BuilderStub {}
@Component({ selector: 'codelab-lifecycle-results-stub', template: '' })
class ResultsStub {}

/** The REAL route entries; only the two components that are not under test are stubbed. */
const real = (path: string) => {
  const route = routes.find((r) => r.path === path);
  if (!route) throw new Error(`route "${path}" missing from the real config`);
  return route;
};
const lifecycleRoutes: Routes = [
  { ...real('interview'), component: BuilderStub },
  real('interview/session/:sessionId'),
  { ...real('interview/results/:sessionId'), component: ResultsStub }
];

// ── the probe ────────────────────────────────────────────────────────
//
// Installed ONCE, before this file creates the component for the first time:
// Angular captures lifecycle hooks when a component's view is first built, so a
// spy added later would never be called.
type Probe = { status: string; macrotaskElapsed: boolean };
const seen: Probe[] = [];
let macrotaskElapsed = false;
let originalOnInit: () => void;

beforeAll(() => {
  originalOnInit = InterviewSessionComponent.prototype.ngOnInit;
  jest.spyOn(InterviewSessionComponent.prototype, 'ngOnInit').mockImplementation(function (
    this: InterviewSessionComponent
  ) {
    seen.push({ status: this.status(), macrotaskElapsed });
    return originalOnInit.call(this);
  });

  // "No gap" check: the instant the session guard lets the navigation through,
  // arm a macrotask. An HTTP response can only change the session status by
  // running as a macrotask, so if the component initialises BEFORE it fires,
  // nothing can interleave between "guard said yes" and "component exists".
  const guardProto = BackendInterviewSessionGuard.prototype;
  const originalCanActivate = guardProto.canActivate;
  jest.spyOn(guardProto, 'canActivate').mockImplementation(async function (
    this: BackendInterviewSessionGuard, route
  ) {
    const outcome = await originalCanActivate.call(this, route);
    if (outcome === true) {
      macrotaskElapsed = false;
      setTimeout(() => { macrotaskElapsed = true; }, 0);
    }
    return outcome;
  });
});
afterAll(() => jest.restoreAllMocks());

// ── harness ──────────────────────────────────────────────────────────
let api: {
  resumeSession: jest.Mock; getResult: jest.Mock; submitSession: jest.Mock;
  saveAnswer: jest.Mock; setReviewFlag: jest.Mock;
};
let storage: InterviewSessionReferenceStorage;

function configure(): void {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideRouter(lifecycleRoutes),
      provideNoopAnimations(),
      BackendInterviewSessionService,
      BackendInterviewResultService,
      BackendInterviewTimerService,
      InterviewSessionReferenceStorage,
      InterviewHistoryService,
      { provide: InterviewApiService, useValue: api }
    ]
  });
  storage = TestBed.inject(InterviewSessionReferenceStorage);
}

const resumeFails = (code: InterviewApiErrorCode, status: number) =>
  api.resumeSession.mockReturnValue(throwError(() => new InterviewApiError(code, status)));
const resultFails = (code: InterviewApiErrorCode, status: number) =>
  api.getResult.mockReturnValue(throwError(() => new InterviewApiError(code, status)));

const sessionService = () => TestBed.inject(BackendInterviewSessionService);
const currentPath = () => TestBed.inject(Router).url.split('?')[0];
const statusesAtInit = () => seen.map((p) => p.status);

/** The property under test: at no point did the component start up over a finished session. */
function expectNeverInitialisedOverAFinishedSession(): void {
  expect(statusesAtInit().filter((s) => s === 'submitted' || s === 'expired')).toEqual([]);
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  seen.length = 0;
  macrotaskElapsed = false;
  api = {
    resumeSession: jest.fn(), getResult: jest.fn(), submitSession: jest.fn(),
    saveAnswer: jest.fn(), setReviewFlag: jest.fn()
  };
  configure();
});
afterEach(() => {
  // Destroys the routed component, which stops its display timer.
  TestBed.resetTestingModule();
  sessionStorage.clear();
  localStorage.clear();
});

describe('the real route configuration', () => {
  it('serves the session URL from an eagerly bound component behind ONE guard, with nothing that could open a timing gap', () => {
    const route = real('interview/session/:sessionId');

    expect(route.component).toBe(InterviewSessionComponent);
    expect(route.canActivate).toEqual([BackendInterviewSessionGuard]);
    // Each of these would let an async step (or a lazy chunk download) sit between
    // "the guard said yes" and "the component exists".
    expect(route.loadComponent).toBeUndefined();
    expect(route.resolve).toBeUndefined();
    expect(route.children).toBeUndefined();
    expect(route.loadChildren).toBeUndefined();
    expect(route.runGuardsAndResolvers).toBeUndefined();
    expect(route.canMatch).toBeUndefined();
    expect(route.canDeactivate).toBeUndefined();
  });

  it('the component is reachable through this ONE route only', () => {
    const owners = routes.filter((r) => r.component === InterviewSessionComponent);
    expect(owners.map((r) => r.path)).toEqual(['interview/session/:sessionId']);
  });
});

describe('the probe itself (positive control)', () => {
  it('DOES record a finished status when a component is created over one — so a clean run below means something', () => {
    storage.write('is_1', TOKEN, 0);
    sessionService().activateCreatedSession(SESSION, TOKEN);
    api.submitSession.mockReturnValue(of(result()));

    return sessionService().submit().then(() => {
      expect(sessionService().status()).toBe('submitted');

      // Bypasses the router and its guard entirely — the one way to build it over a finished session.
      const fixture = TestBed.createComponent(InterviewSessionComponent);
      fixture.detectChanges();
      fixture.destroy();

      expect(statusesAtInit()).toEqual(['submitted']);
    });
  });
});

describe('active session', () => {
  beforeEach(() => {
    storage.write('is_1', TOKEN, 0);
    api.resumeSession.mockReturnValue(of(SESSION));
  });

  it('direct entry: the component starts ACTIVE, one resume, no result probe', async () => {
    await RouterTestingHarness.create(SESSION_URL);

    expect(currentPath()).toBe(SESSION_URL);
    expect(statusesAtInit()).toEqual(['active']);
    expect(api.resumeSession).toHaveBeenCalledTimes(1);
    expect(api.getResult).not.toHaveBeenCalled();
  });

  it('the component initialises in the SAME macrotask as the guard’s yes — no window for a response to change the status', async () => {
    await RouterTestingHarness.create(SESSION_URL);

    expect(seen).toEqual([{ status: 'active', macrotaskElapsed: false }]);
  });

  it('in-app navigation from the builder: still ACTIVE at init', async () => {
    const harness = await RouterTestingHarness.create('/interview');
    await harness.navigateByUrl(SESSION_URL);

    expect(currentPath()).toBe(SESSION_URL);
    expect(statusesAtInit()).toEqual(['active']);
  });

  it('a browser refresh (fresh services, same sessionStorage) starts ACTIVE again', async () => {
    await RouterTestingHarness.create(SESSION_URL);
    expect(statusesAtInit()).toEqual(['active']);

    configure();   // new page load: every singleton is new, sessionStorage survives
    api.resumeSession.mockReturnValue(of(SESSION));
    await RouterTestingHarness.create(SESSION_URL);

    expect(statusesAtInit()).toEqual(['active', 'active']);
    expectNeverInitialisedOverAFinishedSession();
  });

  it('two overlapping navigations to the same URL share ONE resume and create at most one ACTIVE component', async () => {
    const harness = await RouterTestingHarness.create('/interview');
    await Promise.all([harness.navigateByUrl(SESSION_URL), harness.navigateByUrl(SESSION_URL)]);

    expect(api.resumeSession).toHaveBeenCalledTimes(1);
    expect(statusesAtInit().every((s) => s === 'active')).toBe(true);
    expect(statusesAtInit().length).toBeLessThanOrEqual(1);
  });
});

describe.each([
  ['submitted normally (resume CONFLICT)', 'CONFLICT', false],
  ['expired and NEVER finalized (resume SESSION_EXPIRED)', 'SESSION_EXPIRED', true],
  ['expired and ALREADY finalized (the server now says submitted, by expiry)', 'CONFLICT', true]
] as const)('finished session — %s', (_label, resumeCode, byExpiry) => {
  beforeEach(() => storage.write('is_1', TOKEN, 0));

  it('direct entry / refresh: confirmed and sent to Results — the component is NEVER created', async () => {
    resumeFails(resumeCode, 409);
    api.getResult.mockReturnValue(of(result({ submittedByExpiry: byExpiry })));

    await RouterTestingHarness.create(SESSION_URL);

    expect(currentPath()).toBe(RESULTS_URL);
    expect(seen).toEqual([]);
    expect(api.getResult).toHaveBeenCalledTimes(1);
    expect(sessionService().status()).not.toBe('loading');
  });

  it('in-app navigation: the same', async () => {
    resumeFails(resumeCode, 409);
    api.getResult.mockReturnValue(of(result({ submittedByExpiry: byExpiry })));

    const harness = await RouterTestingHarness.create('/interview');
    await harness.navigateByUrl(SESSION_URL);

    expect(currentPath()).toBe(RESULTS_URL);
    expect(seen).toEqual([]);
  });

  it('a dead credential found while confirming goes to the builder — the component is NEVER created', async () => {
    resumeFails(resumeCode, 409);
    resultFails('UNAUTHORIZED', 401);

    await RouterTestingHarness.create(SESSION_URL);

    expect(currentPath()).toBe('/interview');
    expect(seen).toEqual([]);
  });

  describe('when the result cannot confirm it', () => {
    it.each([
      ['a 500', 'BACKEND_UNAVAILABLE', 500],
      ['a network failure', 'BACKEND_UNAVAILABLE', 0],
      ['a 409 (still running)', 'CONFLICT', 409]
    ] as const)('%s: the component IS created — over the ERROR state, never over a finished one', async (_l, code, status) => {
      resumeFails(resumeCode, 409);
      resultFails(code, status);

      await RouterTestingHarness.create(SESSION_URL);

      expect(currentPath()).toBe(SESSION_URL);
      expect(statusesAtInit()).toEqual(['error']);
      expect(sessionService().errorReason()).toBe('unconfirmed');
      expectNeverInitialisedOverAFinishedSession();
    });

    it('Retry from there: a CONFIRMED finish leaves for Results without a second initialisation', async () => {
      resumeFails(resumeCode, 409);
      resultFails('BACKEND_UNAVAILABLE', 500);
      const harness = await RouterTestingHarness.create(SESSION_URL);
      const component = harness.routeDebugElement!.componentInstance as InterviewSessionComponent;
      expect(statusesAtInit()).toEqual(['error']);

      api.getResult.mockReturnValue(of(result({ submittedByExpiry: byExpiry })));
      await component.retryResume();
      await harness.fixture.whenStable();

      expect(currentPath()).toBe(RESULTS_URL);
      // While the retry ran the status went through 'submitted' / 'expired' with
      // the component alive — but ngOnInit ran exactly once, over 'error'.
      expect(statusesAtInit()).toEqual(['error']);
    });
  });
});

describe('missing or invalid credentials', () => {
  it('no stored reference: builder, no request at all, no component', async () => {
    api.resumeSession.mockReturnValue(of(SESSION));

    await RouterTestingHarness.create(SESSION_URL);

    expect(currentPath()).toBe('/interview');
    expect(seen).toEqual([]);
    expect(api.resumeSession).not.toHaveBeenCalled();
    expect(api.getResult).not.toHaveBeenCalled();
  });

  it('a stored reference for a DIFFERENT session: builder, reference kept, no request', async () => {
    storage.write('is_other', TOKEN, 0);

    await RouterTestingHarness.create(SESSION_URL);

    expect(currentPath()).toBe('/interview');
    expect(seen).toEqual([]);
    expect(api.resumeSession).not.toHaveBeenCalled();
    expect(storage.read()?.sessionId).toBe('is_other');
  });

  it('a 401 on resume: builder, reference cleared, never probes the result', async () => {
    storage.write('is_1', TOKEN, 0);
    resumeFails('UNAUTHORIZED', 401);

    await RouterTestingHarness.create(SESSION_URL);

    expect(currentPath()).toBe('/interview');
    expect(seen).toEqual([]);
    expect(api.getResult).not.toHaveBeenCalled();
    expect(storage.read()).toBeNull();
  });
});

describe('an unreachable backend', () => {
  it('lets the component through over the ERROR state (its retry card), not a finished one', async () => {
    storage.write('is_1', TOKEN, 0);
    resumeFails('BACKEND_UNAVAILABLE', 0);

    await RouterTestingHarness.create(SESSION_URL);

    expect(currentPath()).toBe(SESSION_URL);
    expect(statusesAtInit()).toEqual(['error']);
    expect(sessionService().errorReason()).toBe('unreachable');
    expect(api.getResult).not.toHaveBeenCalled();
  });
});

describe('state left over in the singleton services', () => {
  /** A session that was submitted normally in this page load, so `status === 'submitted'` and a result is held. */
  async function leaveSubmittedStateBehind(): Promise<void> {
    storage.write('is_1', TOKEN, 0);
    sessionService().activateCreatedSession(SESSION, TOKEN);
    api.submitSession.mockReturnValue(of(result()));
    await sessionService().submit();
    expect(sessionService().status()).toBe('submitted');
  }

  it('stale "submitted" + a backend that cannot be reached: the resume overwrites it BEFORE the guard decides', async () => {
    await leaveSubmittedStateBehind();
    resumeFails('BACKEND_UNAVAILABLE', 0);

    // The stale in-memory result makes this look "finished"; the resume is what decides.
    await RouterTestingHarness.create(SESSION_URL);

    expect(statusesAtInit().every((s) => s !== 'submitted' && s !== 'expired')).toBe(true);
  });

  it('stale "submitted" + an active resume: the component starts ACTIVE', async () => {
    await leaveSubmittedStateBehind();
    api.resumeSession.mockReturnValue(of(SESSION));

    await RouterTestingHarness.create(SESSION_URL);

    expect(statusesAtInit()).toEqual(['active']);
  });

  it('a manual submit, then Back to the session URL: redirected to Results from memory — the component is not recreated', async () => {
    storage.write('is_1', TOKEN, 0);
    api.resumeSession.mockReturnValue(of(SESSION));
    const harness = await RouterTestingHarness.create(SESSION_URL);
    expect(statusesAtInit()).toEqual(['active']);

    api.submitSession.mockReturnValue(of(result()));
    await sessionService().submit();
    await harness.navigateByUrl(RESULTS_URL);
    expect(currentPath()).toBe(RESULTS_URL);

    resumeFails('CONFLICT', 409);   // the server: already submitted
    await harness.navigateByUrl(SESSION_URL);   // the browser Back button

    expect(currentPath()).toBe(RESULTS_URL);
    expect(statusesAtInit()).toEqual(['active']);   // only the original, pre-submit initialisation
    expect(api.getResult).not.toHaveBeenCalled();   // proven from the in-memory result
  });
});

describe('a navigation that never completes', () => {
  it('superseded while the guard is still waiting on the resume: the component is never created', async () => {
    storage.write('is_1', TOKEN, 0);
    const gate = new Subject<InterviewSessionViewModel>();
    api.resumeSession.mockReturnValue(gate);

    const harness = await RouterTestingHarness.create('/interview');
    const pending = harness.navigateByUrl(SESSION_URL);   // the guard is now awaiting the gated resume
    await harness.navigateByUrl('/interview');            // the user goes elsewhere first
    gate.next(SESSION);
    gate.complete();
    await pending.catch(() => undefined);
    await harness.fixture.whenStable();

    expect(currentPath()).toBe('/interview');
    expect(seen).toEqual([]);
  });

  it('superseded while the guard is waiting on the RESULT confirmation: never created, no navigation to Results', async () => {
    storage.write('is_1', TOKEN, 0);
    resumeFails('SESSION_EXPIRED', 409);
    const gate = new Subject<InterviewResultViewModel>();
    api.getResult.mockReturnValue(gate);

    const harness = await RouterTestingHarness.create('/interview');
    const pending = harness.navigateByUrl(SESSION_URL);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));   // let the guard reach the result call
    await harness.navigateByUrl('/interview');
    gate.next(result());
    gate.complete();
    await pending.catch(() => undefined);
    await harness.fixture.whenStable();

    expect(currentPath()).toBe('/interview');
    expect(seen).toEqual([]);
  });
});
