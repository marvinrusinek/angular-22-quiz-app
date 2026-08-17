import { InjectionToken, isDevMode, type Provider } from '@angular/core';

/**
 * Base URL for the private quiz API.
 *
 * ONE centralized definition — no service or component may hard-code a host.
 * This app has no `src/environments` directory and resolves build-time
 * differences with `isDevMode()` (see main.ts), so the same convention is used
 * here rather than introducing a fileReplacements surface just for one value.
 *
 * The URL is PUBLIC configuration, not a secret. No token or credential is
 * ever stored alongside it.
 */
/**
 * A ROOT DEFAULT, not merely a token.
 *
 * Bootstrap still provides this explicitly (`provideApiBaseUrl()` in main.ts)
 * and a test that provides its own literal still wins — the default only
 * decides what happens when nobody said anything.
 *
 * It exists because question CONTENT now arrives from the API, so the data
 * loader injects the questions service transitively. Without a default, every
 * TestBed that constructs QuizService for an unrelated reason has to know about
 * an API three layers away, and ~15 specs failed with NG0201 for a dependency
 * they never asked for. The factory is the same resolution the provider uses,
 * so there is one rule rather than two.
 */
export const API_BASE_URL = new InjectionToken<string>('API_BASE_URL', {
  providedIn: 'root',
  factory: () => normalizeBaseUrl(resolveApiBaseUrl())
});

/** Local backend during `ng serve`. */
export const DEV_API_BASE_URL = 'http://localhost:3000/api';

/**
 * Production backend origin. Deliberately EMPTY until the backend is hosted:
 * a placeholder domain would silently ship a build that looks configured and
 * fails at runtime.
 *
 * While it is empty, Interview Mode fails closed with a clear message and the
 * rest of the app — Topic Quizzes, Practice, history — is unaffected.
 *
 * When the host is chosen, set this AND add the origin to the CSP
 * `connect-src` directive in index.html. Setting only one of the two leaves
 * every request blocked by the browser before it is sent.
 */
export const PROD_API_BASE_URL = 'https://interview-api-c842.onrender.com/api';

/**
 * Whether the API is configured for the current build.
 *
 * Lets a caller FAIL CLOSED with a safe message instead of throwing: in
 * production with no configured origin, Interview Mode must refuse to create a
 * session rather than attempt a request or fall back to local generation.
 */
export function isApiConfigured(
  devMode: boolean = isDevMode(),
  hostname: string | undefined = globalThis.location?.hostname
): boolean {
  return resolveApiBaseUrl(devMode, hostname).trim().length > 0;
}

/**
 * True when the page is served from the developer's own machine.
 *
 * `isDevMode()` alone is not enough to decide which API to call. A dev BUILD
 * can be served from somewhere that is not localhost — StackBlitz is the case
 * that matters here — and there `http://localhost:3000` resolves to whatever
 * happens to be on the viewer's machine, usually nothing. Only a page actually
 * loaded from localhost should talk to a local backend.
 */
function isLocalHost(hostname: string | undefined): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/**
 * Resolve the base URL, or '' when production has no configured origin.
 *
 * This must NEVER throw. It is called from an injection factory, and anything
 * that injects InterviewApiService — the Build Your Interview page, the result
 * guard — would fail to construct, taking the whole route down with it. That
 * is exactly what happened on GitHub Pages: the builder page did not render at
 * all, instead of showing the intended "not configured" message.
 *
 * Failing closed is the job of `isApiConfigured()` at the call site, and of the
 * request layer, which refuses to issue a call against an empty base URL.
 */
export function resolveApiBaseUrl(
  devMode: boolean = isDevMode(),
  hostname: string | undefined = globalThis.location?.hostname
): string {
  // A dev build on the developer's machine talks to the local backend; a dev
  // build served from anywhere else (StackBlitz) uses the hosted API, because
  // no local backend exists for that viewer.
  if (devMode && isLocalHost(hostname)) return DEV_API_BASE_URL;
  return PROD_API_BASE_URL;
}

/** Normalize away a trailing slash so callers can always append `/segment`. */
export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Provider for bootstrap. Tests override it with a literal value instead of
 * depending on build mode.
 */
export function provideApiBaseUrl(url?: string): Provider {
  return {
    provide: API_BASE_URL,
    useFactory: () => normalizeBaseUrl(url ?? resolveApiBaseUrl())
  };
}
