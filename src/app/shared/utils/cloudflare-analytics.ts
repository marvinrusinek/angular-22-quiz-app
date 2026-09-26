import { swallow } from './error-logging';

/**
 * Cloudflare Web Analytics — the standard manual beacon, loaded ONLY on the real
 * production site.
 *
 * Why a loader and not a `<script>` in index.html: a static tag would load (and log
 * CORS errors) on localhost, StackBlitz and every local E2E run. Cloudflare drops
 * data from hostnames that do not match the configured site, but the request, the
 * console noise and the extra network dependency would still happen.
 *
 * The beacon needs no Angular code: once loaded it observes History-API route
 * changes itself, so the SPA is tracked automatically (no Router instrumentation,
 * no custom events, and deliberately NO `spa: false`).
 *
 * The token below is Cloudflare's PUBLIC site identifier — it is visible in the page
 * of every Cloudflare-tracked site — not a credential. Nothing else is configured:
 * no Interview token, answer, id or user data is ever passed to the beacon. (The
 * beacon itself reports the page URL, which for Interview routes contains the
 * non-secret session id; that exposure is an accepted product decision.)
 *
 * CSP: the exact beacon URL is in `script-src` and `https://cloudflareinsights.com`
 * (its only endpoint) is in `connect-src` — both in index.html.
 */

/** The ONLY host analytics runs on. Compared with strict equality, never a substring. */
export const CLOUDFLARE_ANALYTICS_HOST = 'marvinrusinek.github.io';

export const CLOUDFLARE_BEACON_SRC = 'https://static.cloudflareinsights.com/beacon.min.js';

/** Cloudflare Web Analytics site token (public client-side identifier). */
export const CLOUDFLARE_ANALYTICS_TOKEN = 'c29822f3c9394d9aab170a07597cbd66';

/** Marks the inserted script so a repeat call (or a manual tag) is never doubled. */
const BEACON_ATTRIBUTE = 'data-cf-beacon';

/**
 * Insert the Cloudflare beacon when — and only when — this is the production site
 * and the visitor is not an automated (WebDriver) browser. Returns whether a script
 * was inserted.
 *
 * Non-critical by design: it never throws and never blocks bootstrap, and an
 * external script that fails to load cannot affect the app.
 *
 * The inputs default to the real browser globals; they are parameters so the gate is
 * unit-testable without touching a real page.
 */
export function installCloudflareAnalytics(
  doc: Document = document,
  hostname: string = globalThis.location?.hostname ?? '',
  webdriver: boolean | undefined = globalThis.navigator?.webdriver
): boolean {
  try {
    if (hostname !== CLOUDFLARE_ANALYTICS_HOST) return false;   // localhost, 127.0.0.1, StackBlitz, previews…
    if (webdriver === true) return false;                        // automated browsers must not pollute analytics
    if (doc.querySelector(`script[${BEACON_ATTRIBUTE}]`)) return false;   // already present

    const script = doc.createElement('script');
    script.type = 'module';                                      // Cloudflare: required for the manual embed
    script.src = CLOUDFLARE_BEACON_SRC;
    // The beacon reads its own configuration from this attribute (document.currentScript).
    script.setAttribute(BEACON_ATTRIBUTE, JSON.stringify({ token: CLOUDFLARE_ANALYTICS_TOKEN }));
    (doc.head ?? doc.documentElement).appendChild(script);
    return true;
  } catch (err: unknown) {
    swallow('cloudflare-analytics#install', err);
    return false;
  }
}
