'use strict';

const { request } = require('./lib/client');
const { compareValue, assertRuntimeStatus } = require('./lib/compare');
const { TOPIC_QUIZ_ID } = require('./scenarios');

// Must match whatever ALLOWED_ORIGINS value run.js passes to BOTH runtimes.
const ALLOWED_ORIGIN = 'http://parity-allowed.example';
const DISALLOWED_ORIGIN = 'http://parity-disallowed.example';

/** Baseline headers required on every response, present on both runtimes
 *  with the SAME value — the common minimum, not a demand for byte-identical
 *  header sets (Spring adds extra hardening headers Node doesn't; that is a
 *  documented, non-weakening difference, not a failure — see the note below). */
const REQUIRED_HEADERS = {
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store'
};

async function runSecurityScenario({ nodeBase, springBase }) {
  const scenario = 'HTTP/security behavior parity';
  const mismatches = [];
  const notes = [];

  // ── required security/cache headers ──
  const [nodeRes, springRes] = await Promise.all([
    request(nodeBase, 'GET', '/api/quizzes'),
    request(springBase, 'GET', '/api/quizzes')
  ]);
  for (const [header, expectedValue] of Object.entries(REQUIRED_HEADERS)) {
    mismatches.push(
      ...compareValue({ scenario, endpoint: 'GET /api/quizzes header', path: `header:${header} (Node)`, expectedNode: expectedValue, actualSpring: nodeRes.headers[header] }),
      ...compareValue({ scenario, endpoint: 'GET /api/quizzes header', path: `header:${header} (Spring)`, expectedNode: expectedValue, actualSpring: springRes.headers[header] })
    );
  }
  const nodeOnlyExtra = Object.keys(nodeRes.headers).filter((h) => !(h in springRes.headers) && h.startsWith('x-'));
  const springOnlyExtra = Object.keys(springRes.headers).filter((h) => !(h in nodeRes.headers) && (h.startsWith('x-') || h === 'cross-origin-resource-policy' || h === 'pragma'));
  notes.push(`Headers present only on Node: ${JSON.stringify(nodeOnlyExtra)}`);
  notes.push(`Headers present only on Spring: ${JSON.stringify(springOnlyExtra)} (documented additional hardening — Cross-Origin-Resource-Policy/Pragma — not required of Node, not a mismatch)`);

  // ── CORS: allowed origin ──
  const [nodeAllowed, springAllowed] = await Promise.all([
    request(nodeBase, 'GET', '/api/quizzes', { headers: { origin: ALLOWED_ORIGIN } }),
    request(springBase, 'GET', '/api/quizzes', { headers: { origin: ALLOWED_ORIGIN } })
  ]);
  mismatches.push(
    ...compareValue({
      scenario,
      endpoint: 'GET /api/quizzes (allowed origin)',
      path: 'header:access-control-allow-origin',
      expectedNode: nodeAllowed.headers['access-control-allow-origin'],
      actualSpring: springAllowed.headers['access-control-allow-origin']
    })
  );
  // Independent per-runtime check: both runtimes agreeing is not enough if
  // BOTH silently omit the header (which would still let a real browser
  // block the response) — each must actually echo the allowed origin.
  for (const [label, res] of [['Node', nodeAllowed], ['Spring', springAllowed]]) {
    if (res.headers['access-control-allow-origin'] !== ALLOWED_ORIGIN) {
      mismatches.push({ endpoint: 'GET /api/quizzes (allowed origin, independent check)', path: `header:access-control-allow-origin (${label})`, expected: ALLOWED_ORIGIN, actual: res.headers['access-control-allow-origin'] });
    }
  }

  // ── CORS: disallowed-origin PREFLIGHT.
  //
  // An EARLIER version of this comment claimed Spring returns 403 here while
  // Node returns 204 — that description was carried over from a research
  // summary and was NEVER independently verified against a real request.
  // Direct verification (a standalone probe against Node, then three full
  // harness runs against both real, running apps) shows that claim was
  // WRONG: for a disallowed origin, Node's cors() middleware does not send
  // its own 204 short-circuit at all (that only happens for an ALLOWED
  // origin) — it calls next() with no CORS headers attached, and the
  // request falls through to Express's own default OPTIONS handling, which
  // answers 200. Spring, measured the same way, ALSO answers 200. There is
  // no status-code divergence to document here after all.
  //
  // The only property that actually matters to a browser is whether the
  // Access-Control-Allow-Origin header is present and correct — a status
  // code alone (200, 204, or 403) tells a browser nothing; it decides
  // purely from that header. So THAT is what gets a hard assertion below,
  // independent of whatever status code either runtime happens to answer
  // with.
  const [nodePreflight, springPreflight] = await Promise.all([
    request(nodeBase, 'OPTIONS', `/api/quizzes/${TOPIC_QUIZ_ID}/check`, {
      headers: { origin: DISALLOWED_ORIGIN, 'access-control-request-method': 'POST' }
    }),
    request(springBase, 'OPTIONS', `/api/quizzes/${TOPIC_QUIZ_ID}/check`, {
      headers: { origin: DISALLOWED_ORIGIN, 'access-control-request-method': 'POST' }
    })
  ]);
  notes.push(
    `Disallowed-origin preflight: Node status=${nodePreflight.status}, Spring status=${springPreflight.status} ` +
    '(verified: no status-code divergence — see the comment above this check for the correction). ' +
    'The security-relevant assertion is that NEITHER leaks an Access-Control-Allow-Origin header, checked below regardless of status code.'
  );
  for (const [label, res] of [['Node', nodePreflight], ['Spring', springPreflight]]) {
    if (res.headers['access-control-allow-origin']) {
      mismatches.push({ endpoint: 'OPTIONS (disallowed origin)', path: 'header:access-control-allow-origin', expected: '(absent)', actual: `${label} sent it anyway: ${res.headers['access-control-allow-origin']}` });
    }
  }

  // ── request-size limit ──
  const oversizedBody = JSON.stringify({ padding: 'x'.repeat(40 * 1024) });
  const [nodeOversize, springOversize] = await Promise.all([
    request(nodeBase, 'POST', `/api/quizzes/${TOPIC_QUIZ_ID}/attempts`, { headers: { 'content-type': 'application/json' }, body: oversizedBody }),
    request(springBase, 'POST', `/api/quizzes/${TOPIC_QUIZ_ID}/attempts`, { headers: { 'content-type': 'application/json' }, body: oversizedBody })
  ]);
  mismatches.push(
    ...compareValue({ scenario, endpoint: 'POST oversized body', path: '$.status', expectedNode: nodeOversize.status, actualSpring: springOversize.status }),
    ...compareValue({ scenario, endpoint: 'POST oversized body', path: '$.body.error.code', expectedNode: nodeOversize.body?.error?.code, actualSpring: springOversize.body?.error?.code }),
    // Independent: an oversized body MUST be rejected (413) on each side —
    // both runtimes silently accepting it would still "match".
    ...assertRuntimeStatus({
      scenario,
      endpoint: 'POST oversized body',
      nodeStatus: nodeOversize.status,
      springStatus: springOversize.status,
      isAcceptable: (status) => status === 413,
      labelA: 'Node',
      labelB: 'Spring'
    })
  );

  // ── health/readiness — kept SEPARATE deliberately, not forced to equality.
  // Both expose GET /api/health (parity by design); Spring ALSO exposes a
  // distinct /actuator/health/readiness the harness does not compare against
  // anything, since it intentionally has no Node equivalent.
  const [nodeHealth, springHealth] = await Promise.all([
    request(nodeBase, 'GET', '/api/health'),
    request(springBase, 'GET', '/api/health')
  ]);
  notes.push(`GET /api/health — Node status=${nodeHealth.status}, Spring status=${springHealth.status} (both expected 200; response body shape intentionally not compared beyond status, since liveness body content is not a public contract)`);
  mismatches.push(
    ...compareValue({ scenario, endpoint: 'GET /api/health', path: '$.status', expectedNode: 200, actualSpring: nodeHealth.status }),
    ...compareValue({ scenario, endpoint: 'GET /api/health', path: '$.status', expectedNode: 200, actualSpring: springHealth.status })
  );

  return { scenario, mismatches, notes };
}

module.exports = { runSecurityScenario, ALLOWED_ORIGIN, DISALLOWED_ORIGIN };
