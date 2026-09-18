import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { InterviewWarmupCoordinatorService } from './interview-warmup-coordinator.service';
import { INTERVIEW_API_BASE_URL } from '../../tokens/api-base-url.token';

const BASE = 'http://spring.test/api';

describe('InterviewWarmupCoordinatorService', () => {
  let service: InterviewWarmupCoordinatorService;
  let http: HttpTestingController;

  function setup(baseUrl = BASE): void {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: INTERVIEW_API_BASE_URL, useValue: baseUrl }
      ]
    });
    service = TestBed.inject(InterviewWarmupCoordinatorService);
    http = TestBed.inject(HttpTestingController);
  }

  afterEach(() => {
    http.verify();
  });

  it('idle: the first call issues exactly one GET /health, with no headers or body', () => {
    setup();
    service.warmUp().subscribe();

    const req = http.expectOne(`${BASE}/health`);
    expect(req.request.method).toBe('GET');
    expect(req.request.headers.has('Authorization')).toBe(false);
    expect(req.request.headers.has('Idempotency-Key')).toBe(false);
    expect(req.request.body).toBeNull();
    req.flush({ status: 'UP' });
  });

  it('in-flight: two concurrent callers before the request resolves share the SAME observable — one request total', () => {
    setup();
    let a: unknown = 'unset';
    let b: unknown = 'unset';
    service.warmUp().subscribe((v) => (a = v));
    service.warmUp().subscribe((v) => (b = v));

    const reqs = http.match(`${BASE}/health`);
    expect(reqs).toHaveLength(1);
    reqs[0].flush({ status: 'UP' });

    expect(a).toBeUndefined();
    expect(b).toBeUndefined();
  });

  it('success: cached as complete for the app lifetime — a later caller gets no new request', () => {
    setup();
    service.warmUp().subscribe();
    http.expectOne(`${BASE}/health`).flush({ status: 'UP' });

    let value: unknown = 'unset';
    service.warmUp().subscribe((v) => (value = v));

    http.expectNone(`${BASE}/health`);
    expect(value).toBeUndefined();
  });

  it('success: a THIRD later call, well after the first two, still issues no new request', () => {
    setup();
    service.warmUp().subscribe();
    http.expectOne(`${BASE}/health`).flush({ status: 'UP' });
    service.warmUp().subscribe();
    http.expectNone(`${BASE}/health`);
    // A third, independent call — same story.
    service.warmUp().subscribe();
    http.expectNone(`${BASE}/health`);
  });

  it('failure: never surfaces as an error to the caller — resolves to undefined', (done) => {
    setup();
    service.warmUp().subscribe({
      next: (v) => {
        expect(v).toBeUndefined();
        done();
      },
      error: () => done(new Error('warmUp() must never error'))
    });
    http.expectOne(`${BASE}/health`).error(new ProgressEvent('error'), { status: 503, statusText: 'Service Unavailable' });
  });

  it('failure: clears in-flight state so exactly ONE later caller can retry', () => {
    setup();
    service.warmUp().subscribe();
    http.expectOne(`${BASE}/health`).error(new ProgressEvent('error'), { status: 503, statusText: 'Service Unavailable' });

    // A later call after the failure gets a FRESH request, not a cached one.
    service.warmUp().subscribe();
    const retryReq = http.expectOne(`${BASE}/health`);
    expect(retryReq.request.method).toBe('GET');
    retryReq.flush({ status: 'UP' });
  });

  it('failure: does not permanently poison the coordinator — a later SUCCESS is still cached as complete afterward', () => {
    setup();
    service.warmUp().subscribe();
    http.expectOne(`${BASE}/health`).error(new ProgressEvent('error'), { status: 503, statusText: 'Service Unavailable' });

    service.warmUp().subscribe();
    http.expectOne(`${BASE}/health`).flush({ status: 'UP' });

    // Now cached — no further requests, ever, for this instance.
    service.warmUp().subscribe();
    http.expectNone(`${BASE}/health`);
  });

  it('timeout/network failure (never resolves, then errors) also resets in-flight state for one retry', () => {
    setup();
    service.warmUp().subscribe();
    const req = http.expectOne(`${BASE}/health`);
    // Simulate a hard network failure rather than an HTTP error status.
    req.error(new ProgressEvent('timeout'));

    service.warmUp().subscribe();
    http.expectOne(`${BASE}/health`).flush({ status: 'UP' });
  });

  it('component-destruction-equivalent: unsubscribing early does not cancel the underlying shared request', () => {
    setup();
    const sub = service.warmUp().subscribe();
    const req = http.expectOne(`${BASE}/health`);

    sub.unsubscribe(); // simulates a component being destroyed mid-request

    expect(req.cancelled).toBe(false);
    expect(() => req.flush({ status: 'UP' })).not.toThrow();
  });

  it('a second caller joining after the first unsubscribed still gets the shared (not cancelled) request', () => {
    setup();
    const sub = service.warmUp().subscribe();
    sub.unsubscribe();

    let value: unknown = 'unset';
    service.warmUp().subscribe((v) => (value = v));

    const reqs = http.match(`${BASE}/health`);
    expect(reqs).toHaveLength(1); // still shared — no second request was issued
    reqs[0].flush({ status: 'UP' });
    expect(value).toBeUndefined();
  });

  it('unconfigured origin: resolves silently to undefined with no request at all', (done) => {
    setup('');
    service.warmUp().subscribe((v) => {
      expect(v).toBeUndefined();
      http.expectNone(() => true);
      done();
    });
  });

  it('a bare .subscribe() with no error handler — the EXACT pattern both QuizSelectionComponent and BuildYourInterviewComponent use — never leaks an unhandled error, even to two concurrent bare subscribers sharing the same failing in-flight request', () => {
    setup();
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const windowErrors: unknown[] = [];
    const onWindowError = (e: ErrorEvent) => windowErrors.push(e.error ?? e.message);
    window.addEventListener('error', onWindowError);

    try {
      // Mirrors QuizSelectionComponent's `this.warmupCoordinator.warmUp().subscribe();`
      // and BuildYourInterviewComponent's equivalent (takeUntilDestroyed only
      // affects teardown timing, not error delivery) — both fire before the
      // shared request has resolved, exactly as they could on a real page.
      expect(() => service.warmUp().subscribe()).not.toThrow();
      expect(() => service.warmUp().subscribe()).not.toThrow();

      const req = http.expectOne(`${BASE}/health`);
      expect(() =>
        req.error(new ProgressEvent('error'), { status: 503, statusText: 'Service Unavailable' })
      ).not.toThrow();

      expect(consoleErrorSpy).not.toHaveBeenCalled();
      expect(windowErrors).toEqual([]);

      // The failure-reset contract must still hold afterward — a bare
      // subscribe never accidentally suppresses the retry-enabling reset.
      expect(() => service.warmUp().subscribe()).not.toThrow();
      const retryReq = http.expectOne(`${BASE}/health`);
      expect(() => retryReq.flush({ status: 'UP' })).not.toThrow();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
      expect(windowErrors).toEqual([]);
    } finally {
      window.removeEventListener('error', onWindowError);
      consoleErrorSpy.mockRestore();
    }
  });

  it('no timer, interval, or polling: a single failed attempt never automatically retries on its own', () => {
    jest.useFakeTimers();
    try {
      setup();
      service.warmUp().subscribe();
      http.expectOne(`${BASE}/health`).error(new ProgressEvent('error'), { status: 503, statusText: 'Service Unavailable' });

      // Advance time well past any plausible polling interval — no automatic
      // second request may appear on its own; only an explicit caller can
      // trigger one (proven in the "failure: clears in-flight" test above).
      jest.advanceTimersByTime(5 * 60_000);
      http.expectNone(`${BASE}/health`);
    } finally {
      jest.useRealTimers();
    }
  });
});
