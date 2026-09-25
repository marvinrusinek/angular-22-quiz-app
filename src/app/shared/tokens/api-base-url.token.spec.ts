import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';

import { of } from 'rxjs';

import {
  API_BASE_URL,
  DEV_API_BASE_URL,
  INTERVIEW_API_BASE_URL,
  INTERVIEW_DEV_API_BASE_URL,
  INTERVIEW_PROD_API_BASE_URL,
  isInterviewApiConfigured,
  normalizeBaseUrl,
  PROD_API_BASE_URL,
  provideApiBaseUrl,
  provideInterviewApiBaseUrl,
  resolveApiBaseUrl,
  resolveInterviewApiBaseUrl
} from './api-base-url.token';
import { InterviewApiService } from '@shared/services/api/interview-api.service';
import { TopicQuizMetadataService } from '@shared/services/api/topic-quiz-metadata.service';

/**
 * REGRESSION: `resolveApiBaseUrl` used to THROW when production had no
 * configured origin. It runs inside an injection factory, so anything that
 * injected InterviewApiService — Build Your Interview, the result guard —
 * failed to construct, and the whole /interview route rendered nothing on
 * GitHub Pages instead of showing the intended "not configured" message.
 *
 * The rule now: resolution never throws; the CALL SITE fails closed.
 */
describe('resolveApiBaseUrl never throws', () => {
  it('returns the dev URL in development', () => {
    expect(resolveApiBaseUrl(true)).toBe(DEV_API_BASE_URL);
  });

  it('returns the configured value (or empty) in production, without throwing', () => {
    expect(() => resolveApiBaseUrl(false)).not.toThrow();
    expect(resolveApiBaseUrl(false)).toBe(PROD_API_BASE_URL);
  });

  it('the injection factory resolves in an unconfigured production build', () => {
    // The exact path that broke the live site.
    expect(() => {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({ providers: [provideApiBaseUrl(resolveApiBaseUrl(false))] });
      TestBed.inject(API_BASE_URL);
    }).not.toThrow();
  });
});

describe('isInterviewApiConfigured', () => {
  it('is always true in development', () => {
    expect(isInterviewApiConfigured(true)).toBe(true);
  });

  it('follows INTERVIEW_PROD_API_BASE_URL in production', () => {
    expect(isInterviewApiConfigured(false)).toBe(INTERVIEW_PROD_API_BASE_URL.trim().length > 0);
  });
});

describe('normalizeBaseUrl', () => {
  it('strips trailing slashes so callers can append a segment', () => {
    expect(normalizeBaseUrl('https://api.example.com/')).toBe('https://api.example.com');
    expect(normalizeBaseUrl('https://api.example.com///')).toBe('https://api.example.com');
    expect(normalizeBaseUrl('')).toBe('');
  });
});

describe('InterviewApiService with NO configured Spring origin', () => {
  let api: InterviewApiService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideInterviewApiBaseUrl(''),
        // Node's own base stays configured — an unconfigured Spring origin
        // must not affect getQuizMetadata()'s delegation to Node.
        provideApiBaseUrl('http://node.test/api'),
        { provide: TopicQuizMetadataService, useValue: { load: () => of([]) } },
        InterviewApiService
      ]
    });
    api = TestBed.inject(InterviewApiService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('constructs fine — the component tree must not die', () => {
    expect(api).toBeTruthy();
  });

  /**
   * An empty base URL would make every URL RELATIVE, so the request would hit
   * the static site host and be answered with its index.html — an HTML body
   * parsed as a session. Failing is strictly better.
   */
  it.each([
    ['createSession', () => api.createSession({
      mode: 'custom', difficulty: 'beginner', topicIds: ['a'], questionCount: 10
    })],
    ['resumeSession', () => api.resumeSession('is_1', 't')],
    ['saveAnswer', () => api.saveAnswer('is_1', 't', 'q', [1])],
    ['submitSession', () => api.submitSession('is_1', 't')],
    ['getResult', () => api.getResult('is_1', 't')]
  ])('%s issues NO request and errors as unreachable', (_name, call) => {
    let code = '';
    (call() as { subscribe: (o: { error: (e: { code: string }) => void }) => void })
      .subscribe({ error: (err) => { code = err.code; } });

    expect(code).toBe('BACKEND_UNAVAILABLE');
    http.expectNone(() => true);   // nothing left the app
  });

  it('getQuizMetadata still succeeds — delegation never depends on INTERVIEW_API_BASE_URL', (done) => {
    api.getQuizMetadata().subscribe((quizzes) => {
      expect(quizzes).toEqual([]);
      done();
    });
    http.expectNone(() => true);
  });
});

/**
 * Which API a build talks to depends on WHERE THE PAGE IS SERVED FROM, not on
 * the build mode alone.
 *
 * StackBlitz serves a dev build from its own domain. Choosing on `isDevMode()`
 * alone sent it to http://localhost:3000 — the VIEWER's machine, where no
 * backend runs — so Interview Mode reported the service unreachable no matter
 * what was deployed.
 */
describe('API selection follows the serving origin', () => {
  it.each([
    ['localhost', 'localhost'],
    ['loopback IPv4', '127.0.0.1'],
    ['loopback IPv6', '[::1]']
  ])('a dev build on %s uses the LOCAL backend', (_label, hostname) => {
    expect(resolveApiBaseUrl(true, hostname)).toBe(DEV_API_BASE_URL);
  });

  it.each([
    ['StackBlitz webcontainer', 'abc123.local-credentialless.webcontainer-api.io'],
    ['StackBlitz project', 'angular-quiz.stackblitz.io'],
    ['GitHub Pages', 'marvinrusinek.github.io']
  ])('a dev build served from %s uses the HOSTED API', (_label, hostname) => {
    expect(resolveApiBaseUrl(true, hostname)).toBe(PROD_API_BASE_URL);
  });

  it('a production build always uses the hosted API, even on localhost', () => {
    expect(resolveApiBaseUrl(false, 'localhost')).toBe(PROD_API_BASE_URL);
    expect(resolveApiBaseUrl(false, 'marvinrusinek.github.io')).toBe(PROD_API_BASE_URL);
  });

  it('isInterviewApiConfigured agrees with whatever resolveInterviewApiBaseUrl resolved', () => {
    for (const [devMode, hostname] of [
      [true, 'localhost'], [true, 'x.stackblitz.io'], [false, 'marvinrusinek.github.io']
    ] as Array<[boolean, string]>) {
      expect(isInterviewApiConfigured(devMode, hostname))
        .toBe(resolveInterviewApiBaseUrl(devMode, hostname).trim().length > 0);
    }
  });

  it('an unknown hostname does not fall back to localhost', () => {
    // Guards the failure mode directly: never send a non-local page to a
    // backend that only exists on someone else's machine.
    //
    // Passing `undefined` is NOT the same test — an explicit undefined invokes
    // the default parameter, which reads globalThis.location. The real
    // no-location case (a worker, SSR) yields an undefined hostname through
    // that default and is covered by the isLocalHost check itself.
    expect(resolveApiBaseUrl(true, '')).toBe(PROD_API_BASE_URL);
    expect(resolveApiBaseUrl(true, 'example.com')).toBe(PROD_API_BASE_URL);
  });
});

/**
 * Mirrors the block above for the Interview/Spring token — SEPARATE from
 * Node's, resolved independently, and never falling back to the other base.
 */
describe('Interview API selection follows the serving origin', () => {
  it.each([
    ['localhost', 'localhost'],
    ['loopback IPv4', '127.0.0.1'],
    ['loopback IPv6', '[::1]']
  ])('a dev build on %s uses the LOCAL Spring backend', (_label, hostname) => {
    expect(resolveInterviewApiBaseUrl(true, hostname)).toBe(INTERVIEW_DEV_API_BASE_URL);
  });

  it.each([
    ['StackBlitz webcontainer', 'abc123.local-credentialless.webcontainer-api.io'],
    ['StackBlitz project', 'angular-quiz.stackblitz.io'],
    ['GitHub Pages', 'marvinrusinek.github.io']
  ])('a dev build served from %s uses the HOSTED Spring API', (_label, hostname) => {
    expect(resolveInterviewApiBaseUrl(true, hostname)).toBe(INTERVIEW_PROD_API_BASE_URL);
  });

  it('a production build always uses the hosted Spring API, even on localhost', () => {
    expect(resolveInterviewApiBaseUrl(false, 'localhost')).toBe(INTERVIEW_PROD_API_BASE_URL);
    expect(resolveInterviewApiBaseUrl(false, 'marvinrusinek.github.io')).toBe(INTERVIEW_PROD_API_BASE_URL);
  });

  it('an unknown hostname does not fall back to localhost', () => {
    expect(resolveInterviewApiBaseUrl(true, '')).toBe(INTERVIEW_PROD_API_BASE_URL);
    expect(resolveInterviewApiBaseUrl(true, 'example.com')).toBe(INTERVIEW_PROD_API_BASE_URL);
  });

  it('Node and Interview bases resolve to DIFFERENT dev ports and DIFFERENT production origins', () => {
    // The two backends are permanently separate — this is the one test that
    // would fail if either token's resolver were accidentally aliased to the
    // other's constants.
    expect(DEV_API_BASE_URL).not.toBe(INTERVIEW_DEV_API_BASE_URL);
    expect(PROD_API_BASE_URL).not.toBe(INTERVIEW_PROD_API_BASE_URL);
    expect(resolveApiBaseUrl(true, 'localhost')).toBe('http://localhost:3000/api');
    expect(resolveInterviewApiBaseUrl(true, 'localhost')).toBe('http://localhost:8080/api');
  });
});

/**
 * Literal-value regression guard for the Oracle cutover (2026-09-19).
 * Every other test in this file compares against the IMPORTED constants,
 * so it would keep passing even if the constant's value silently reverted
 * or drifted. These assert the actual real-world hostnames so a future
 * accidental revert of the cutover — or an accidental change to Node's
 * permanently-unrelated origin — fails loudly here.
 */
describe('production origins after the Oracle cutover (2026-09-19)', () => {
  it('INTERVIEW_PROD_API_BASE_URL points at Oracle, not Render', () => {
    expect(INTERVIEW_PROD_API_BASE_URL).toBe('https://interview-api-spring.marvinrusinek.com/api');
    expect(INTERVIEW_PROD_API_BASE_URL).not.toContain('onrender.com');
  });

  it('production Interview resolution (any non-local hostname) uses Oracle', () => {
    expect(resolveInterviewApiBaseUrl(false, 'marvinrusinek.github.io'))
      .toBe('https://interview-api-spring.marvinrusinek.com/api');
  });

  it('local Interview resolution is unaffected — still localhost:8080', () => {
    expect(resolveInterviewApiBaseUrl(true, 'localhost')).toBe('http://localhost:8080/api');
    expect(resolveInterviewApiBaseUrl(true, '127.0.0.1')).toBe('http://localhost:8080/api');
  });

  it('Node/Topic Quiz production origin is untouched by the Interview cutover', () => {
    expect(PROD_API_BASE_URL).toBe('https://interview-api-c842.onrender.com/api');
    expect(resolveApiBaseUrl(false, 'marvinrusinek.github.io')).toBe(PROD_API_BASE_URL);
  });
});

describe('bootstrap provider tokens resolve independently', () => {
  it('provideApiBaseUrl and provideInterviewApiBaseUrl register SEPARATE tokens', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideApiBaseUrl('http://node.test/api'),
        provideInterviewApiBaseUrl('http://spring.test/api')
      ]
    });
    expect(TestBed.inject(API_BASE_URL)).toBe('http://node.test/api');
    expect(TestBed.inject(INTERVIEW_API_BASE_URL)).toBe('http://spring.test/api');
  });
});
