import { TestBed } from '@angular/core/testing';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { HttpClient, HttpErrorResponse, provideHttpClient, withInterceptors } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

import { API_BASE_URL } from '../tokens/api-base-url.token';
import { apiErrorInterceptor } from './api-error.interceptor';

const BASE = 'http://api.test/api';
const NON_API_URL = 'https://cdn.example.com/some-asset.json';

describe('apiErrorInterceptor', () => {
  let http: HttpClient;
  let backend: HttpTestingController;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([apiErrorInterceptor])),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: BASE }
      ]
    });
    http = TestBed.inject(HttpClient);
    backend = TestBed.inject(HttpTestingController);
  });

  afterEach(() => backend.verify());

  it('a successful API response passes through completely unchanged', async () => {
    const promise = firstValueFrom(http.get(`${BASE}/quizzes`));
    backend.expectOne(`${BASE}/quizzes`).flush({ quizzes: ['x'] });
    expect(await promise).toEqual({ quizzes: ['x'] });
  });

  it('an API error is rethrown as the SAME HttpErrorResponse, status and body untouched', async () => {
    const promise = firstValueFrom(http.get(`${BASE}/quizzes/does-not-exist/questions`));
    const req = backend.expectOne(`${BASE}/quizzes/does-not-exist/questions`);
    req.flush({ message: 'not found' }, { status: 404, statusText: 'Not Found' });

    await expect(promise).rejects.toBeInstanceOf(HttpErrorResponse);
    await promise.catch((err: HttpErrorResponse) => {
      expect(err.status).toBe(404);
      expect(err.error).toEqual({ message: 'not found' });
    });
  });

  it('preserves the exact original status across a range of failures (400/401/404/500/network)', async () => {
    for (const status of [400, 401, 404, 500, 0] as const) {
      const promise = firstValueFrom(http.get(`${BASE}/quizzes/${status}/check`));
      const req = backend.expectOne(`${BASE}/quizzes/${status}/check`);
      if (status === 0) req.error(new ProgressEvent('error'), { status: 0, statusText: 'Unknown Error' });
      else req.flush({}, { status, statusText: 'error' });
      await expect(promise).rejects.toMatchObject({ status });
    }
  });

  it('does not touch a non-API request at all (different origin than API_BASE_URL)', async () => {
    const promise = firstValueFrom(http.get(NON_API_URL));
    backend.expectOne(NON_API_URL).flush({ ok: true });
    expect(await promise).toEqual({ ok: true });
  });

  it('never logs the request body, response body, or query string — only method/path/status/classification', async () => {
    const logSpy = jest.spyOn(console, 'debug').mockImplementation(() => undefined);
    (globalThis as any).__swallowVerbose = true; // force swallow() to log regardless of isDevMode()

    const promise = firstValueFrom(
      http.post(`${BASE}/quizzes/dependency-injection/check?token=shouldNeverBeLogged`, {
        questionText: 'secret question text',
        selectedOptionTexts: ['secret selection']
      })
    ).catch(() => undefined);

    const req = backend.expectOne(`${BASE}/quizzes/dependency-injection/check?token=shouldNeverBeLogged`);
    req.flush({ serverSecretField: 'should not be logged' }, { status: 400, statusText: 'error' });
    await promise;

    expect(logSpy).toHaveBeenCalled();
    const loggedText = logSpy.mock.calls.flat().map((a) => JSON.stringify(a)).join(' ');
    expect(loggedText).not.toContain('secret question text');
    expect(loggedText).not.toContain('secret selection');
    expect(loggedText).not.toContain('should not be logged');
    expect(loggedText).not.toContain('shouldNeverBeLogged');
    expect(loggedText).not.toContain('token=');

    logSpy.mockRestore();
    delete (globalThis as any).__swallowVerbose;
  });

  // Production-quiet behavior itself (isDevMode() === false silences
  // console output) is owned entirely by swallow() in error-logging.ts,
  // which this interceptor deliberately reuses rather than re-implementing.
  // Angular's isDevMode() is a frozen export that cannot be mocked from a
  // spec, so that gate is not re-derived here; what belongs to THIS
  // interceptor's contract is only that it logs THROUGH swallow() and
  // nothing else, which the "never logs ... only method/path/status" test
  // above already proves by forcing the gate open via __swallowVerbose.
});
