/**
 * StackBlitz preview origins.
 *
 * The API's allow-list is exact by design, which is right for deployed hosts:
 * gh-pages is one fixed origin and stays on the list forever. StackBlitz is
 * different — its preview origin is regenerated per session, so an exact entry
 * is stale by the next time the project is opened.
 *
 * That only became load-bearing at the `/questions` content cutover. Before it,
 * Topic Quiz content came from a bundled asset, so a CORS-blocked API cost
 * StackBlitz only Interview Mode. Now content is API-only and fails closed, so a
 * blocked origin means the quiz has no questions at all.
 *
 * ── Why a suffix test is not a wildcard ────────────────────────────────
 *
 * These are three specific vendor-controlled domains, enumerated because they
 * were actually observed, not a pattern that grows on its own. The check parses
 * the origin as a URL and compares protocol and HOSTNAME, so the classic
 * near-miss attacks fail:
 *
 *   https://webcontainer-api.io.evil.com   hostname ends with evil.com   -> no
 *   https://evilwebcontainer-api.io        no dot before the suffix      -> no
 *   https://evil.stackblitz.io.evil.com    hostname ends with evil.com   -> no
 *   http://abc.stackblitz.io               not https                     -> no
 *
 * A substring/`includes()` test would accept the first and third. The dot is
 * required so a suffix can only match a real subdomain, never a host that
 * merely ends in the same letters.
 *
 * `credentials` stays false for these exactly as for every other origin — this
 * grants read access to public quiz CONTENT, which the endpoint already serves
 * without an answer key. It does not widen what the API discloses.
 */

/** Vendor domains observed serving StackBlitz previews. */
export const STACKBLITZ_PREVIEW_DOMAINS: readonly string[] = [
  'local-credentialless.webcontainer-api.io',
  'w-credentialless-staticblitz.com',
  'stackblitz.io'
];

/**
 * Is this origin an https StackBlitz preview host?
 *
 * Returns false for anything unparseable, so a malformed value can never widen
 * access — the caller's exact allow-list remains the only other way in.
 */
export function isStackBlitzPreviewOrigin(
  origin: string,
  domains: readonly string[] = STACKBLITZ_PREVIEW_DOMAINS
): boolean {
  if (typeof origin !== 'string' || origin.length === 0) return false;

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }

  // HTTPS ONLY. A preview served over http is not something to trust, and
  // production config already refuses http entries in the exact list.
  if (url.protocol !== 'https:') return false;

  // An origin carries no path/query/credentials. Anything that does is not one,
  // and treating it as one would accept `https://evil.com@stackblitz.io`-style
  // confusions in callers that build strings by hand.
  if (url.username !== '' || url.password !== '') return false;
  if (url.pathname !== '/' && url.pathname !== '') return false;
  if (url.search !== '' || url.hash !== '') return false;

  const hostname = url.hostname.toLowerCase();

  return domains.some((domain) => {
    const suffix = domain.toLowerCase();
    // The leading dot is what makes this a SUBDOMAIN test rather than a
    // string-ends-with test: `evilstackblitz.io` must not match `stackblitz.io`.
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  });
}
