'use strict';

// Every outbound call is bounded: an app that hangs on one request (a
// deadlock, a stuck connection pool) must not hang the whole suite forever —
// it has to surface as a real failure instead.
const DEFAULT_TIMEOUT_MS = 10_000;

/** Thin fetch wrapper: always returns {status, headers, body}, parsing JSON
 *  when the content-type says so and falling back to raw text otherwise —
 *  a malformed/tampered-request test can get a non-JSON body and must not
 *  throw before the scenario gets to assert on it. */
async function request(baseUrl, method, path, { headers = {}, body, redirect = 'manual', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    redirect,
    signal: AbortSignal.timeout(timeoutMs)
  });

  const contentType = res.headers.get('content-type') ?? '';
  let parsedBody;
  const raw = await res.text();
  if (contentType.includes('application/json') && raw.length > 0) {
    try {
      parsedBody = JSON.parse(raw);
    } catch {
      parsedBody = raw;
    }
  } else {
    parsedBody = raw;
  }

  const headerEntries = {};
  for (const [key, value] of res.headers.entries()) headerEntries[key.toLowerCase()] = value;

  return { status: res.status, headers: headerEntries, body: parsedBody };
}

module.exports = { request };
