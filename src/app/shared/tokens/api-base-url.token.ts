import { InjectionToken, isDevMode, type Provider } from '@angular/core';

/**
 * Base URLs for this app's two PERMANENT backends — not a migration state.
 *
 * Node/Express owns Quiz Selection, Topic Quiz (questions, attempts,
 * receipts, answer-checking), and Weak Areas Practice's answer-checking.
 * Spring Boot owns Interview Mode's session lifecycle (create, resume,
 * answer, mark-for-review, submit, result). Both share the same Neon
 * Postgres database. See docs/spring-production-runbook.md for the full
 * routing design and rationale — including why Interview builder metadata
 * is deliberately routed through Node (`API_BASE_URL`) rather than Spring,
 * to avoid a duplicate metadata implementation.
 *
 * ONE centralized definition per backend — no service or component may
 * hard-code a host. This app has no `src/environments` directory and
 * resolves build-time differences with `isDevMode()` (see main.ts), so the
 * same convention is used here rather than introducing a fileReplacements
 * surface just for these values.
 *
 * Both URLs are PUBLIC configuration, not secrets. No token or credential is
 * ever stored alongside either.
 */

/**
 * Node/Topic-Quiz base. A ROOT DEFAULT, not merely a token.
 *
 * Bootstrap still provides this explicitly (`provideApiBaseUrl()` in
 * main.ts) and a test that provides its own literal still wins — the
 * default only decides what happens when nobody said anything.
 *
 * It exists because question CONTENT arrives from the API, so the data
 * loader injects the questions service transitively. Without a default,
 * every TestBed that constructs QuizService for an unrelated reason has to
 * know about an API three layers away, and ~15 specs failed with NG0201 for
 * a dependency they never asked for. The factory is the same resolution the
 * provider uses, so there is one rule rather than two.
 */
export const API_BASE_URL = new InjectionToken<string>('API_BASE_URL', {
  providedIn: 'root',
  factory: () => normalizeBaseUrl(resolveApiBaseUrl()),
});

/**
 * Interview/Spring base — a SEPARATE token, not a second value layered onto
 * the one above. Only Interview Mode's session-lifecycle calls
 * (`InterviewApiService`) ever resolve this; every Topic-Quiz-adjacent
 * service keeps resolving `API_BASE_URL` (Node) exactly as before, and
 * `InterviewApiService` itself never injects both — its builder-metadata
 * method delegates to the Node-owned `TopicQuizMetadataService` instead of
 * holding a second base URL of its own.
 */
export const INTERVIEW_API_BASE_URL = new InjectionToken<string>('INTERVIEW_API_BASE_URL', {
  providedIn: 'root',
  factory: () => normalizeBaseUrl(resolveInterviewApiBaseUrl()),
});

/** Node's local backend during `ng serve` — its established dev port (`backend/src/config.ts`'s default, used throughout `scripts/dev.js`). */
export const DEV_API_BASE_URL = 'http://localhost:3000/api';

/**
 * Node production origin — Quiz Selection, Topic Quiz, and Weak Areas
 * Practice, PERMANENTLY. Node is one of two permanent backends, not a
 * rollback target being phased out.
 */
export const PROD_API_BASE_URL = 'https://interview-api-c842.onrender.com/api';

/** Spring's local backend during `ng serve` — its established dev port (`server.port=${PORT:8080}` in `backend-spring/src/main/resources/application.properties`). */
export const INTERVIEW_DEV_API_BASE_URL = 'http://localhost:8080/api';

/**
 * Spring production origin — Interview Mode's session lifecycle only.
 *
 * Changing this value ALONE is not enough: the origin must also be in the
 * CSP `connect-src` directive in index.html, or every request is blocked by
 * the browser before it is sent, with nothing in the network tab to
 * explain why.
 *
 * Interview-only rollback: to route Interview Mode back to Node, change
 * ONLY this constant (or the provider's `url` argument). Node's own CSP
 * origin and `PROD_API_BASE_URL` above are untouched by construction — Topic
 * Quiz routing never moves.
 */
export const INTERVIEW_PROD_API_BASE_URL = 'https://interview-api-spring.marvinrusinek.com/api';

/**
 * True when Interview Mode has a backend origin configured for this build.
 *
 * Lets a caller FAIL CLOSED with a safe message instead of throwing: in
 * production with no configured origin, Interview Mode must refuse to
 * create a session rather than attempt a request or fall back to local
 * generation. Topic Quiz has no equivalent check — Node is the app's core,
 * always-on backend and is always assumed configured.
 */
export function isInterviewApiConfigured(
  devMode: boolean = isDevMode(),
  hostname: string | undefined = globalThis.location?.hostname
): boolean {
  return resolveInterviewApiBaseUrl(devMode, hostname).trim().length > 0;
}

/**
 * True when the page is served from the developer's own machine.
 *
 * `isDevMode()` alone is not enough to decide which API to call. A dev
 * BUILD can be served from somewhere that is not localhost — StackBlitz is
 * the case that matters here — and there `http://localhost:3000` or
 * `http://localhost:8080` resolves to whatever happens to be on the
 * viewer's machine, usually nothing. Only a page actually loaded from
 * localhost should talk to a local backend. Shared by both resolvers below.
 */
function isLocalHost(hostname: string | undefined): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/**
 * Resolve Node's base URL, or '' when production has no configured origin.
 *
 * This must NEVER throw. It is called from an injection factory, and
 * anything that injects a Topic-Quiz-adjacent service would fail to
 * construct, taking the whole route down with it, if it did.
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

/**
 * Resolve Spring's base URL for Interview Mode, or '' when production has no
 * configured origin. Same local-vs-hosted logic as `resolveApiBaseUrl`,
 * against Spring's own dev/prod values — see `isApiConfigured`'s equivalent,
 * `isInterviewApiConfigured`, for the fail-closed check built on this.
 *
 * This must NEVER throw, for the same reason as `resolveApiBaseUrl` above:
 * it runs inside `InterviewApiService`'s injection factory, and anything
 * that injects it — Build Your Interview, the result guard — would fail to
 * construct, taking the whole route down with it, if it did. Failing closed
 * is the job of `isInterviewApiConfigured()` at the call site, and of the
 * request layer, which refuses to issue a call against an empty base URL.
 */
export function resolveInterviewApiBaseUrl(
  devMode: boolean = isDevMode(),
  hostname: string | undefined = globalThis.location?.hostname
): string {
  if (devMode && isLocalHost(hostname)) return INTERVIEW_DEV_API_BASE_URL;
  return INTERVIEW_PROD_API_BASE_URL;
}

/** Normalize away a trailing slash so callers can always append `/segment`. */
export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Provider for bootstrap — Node/Topic-Quiz base. Tests override it with a
 * literal value instead of depending on build mode.
 */
export function provideApiBaseUrl(url?: string): Provider {
  return {
    provide: API_BASE_URL,
    useFactory: () => normalizeBaseUrl(url ?? resolveApiBaseUrl()),
  };
}

/**
 * Provider for bootstrap — Interview/Spring base. Same pattern as
 * `provideApiBaseUrl`, registered separately in `main.ts` alongside it.
 */
export function provideInterviewApiBaseUrl(url?: string): Provider {
  return {
    provide: INTERVIEW_API_BASE_URL,
    useFactory: () => normalizeBaseUrl(url ?? resolveInterviewApiBaseUrl()),
  };
}
