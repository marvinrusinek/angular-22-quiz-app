'use strict';

/**
 * Generic structural diff between two JSON-ish values, used to compare a
 * Node response against the equivalent Spring response for the SAME
 * underlying data (metadata reads, topic-quiz check outcomes, error
 * envelopes, headers) — cases with no independent randomness on either side.
 *
 * `expected` is always the NODE value: Node remains the production rollback
 * service for this migration (see run.js), so it is the reference baseline
 * a mismatch report measures Spring against — not a claim that Node is
 * "more correct", just a fixed, consistent direction for every report.
 *
 * `ignorePaths` entries are either an exact dot/bracket path string
 * ("config.expiresAt") or a RegExp tested against the same path string, for
 * genuinely volatile fields (generated timestamps, opaque tokens) — every
 * entry actually used by a caller is documented at its call site.
 */
function diffJson(expectedNode, actualSpring, { ignorePaths = [], path = '$' } = {}) {
  const isIgnored = (p) => ignorePaths.some((rule) => (rule instanceof RegExp ? rule.test(p) : rule === p));
  if (isIgnored(path)) return [];

  const bothObjects = isPlainObject(expectedNode) && isPlainObject(actualSpring);
  const bothArrays = Array.isArray(expectedNode) && Array.isArray(actualSpring);

  if (bothArrays) {
    const mismatches = [];
    const len = Math.max(expectedNode.length, actualSpring.length);
    for (let i = 0; i < len; i++) {
      mismatches.push(
        ...diffJson(expectedNode[i], actualSpring[i], { ignorePaths, path: `${path}[${i}]` })
      );
    }
    return mismatches;
  }

  if (bothObjects) {
    const mismatches = [];
    const keys = new Set([...Object.keys(expectedNode), ...Object.keys(actualSpring)]);
    for (const key of keys) {
      mismatches.push(
        ...diffJson(expectedNode[key], actualSpring[key], { ignorePaths, path: `${path}.${key}` })
      );
    }
    return mismatches;
  }

  if (!deepEqualPrimitive(expectedNode, actualSpring)) {
    return [{ path, expectedNode, actualSpring }];
  }
  return [];
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepEqualPrimitive(a, b) {
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  return a === b;
}

/**
 * Runs diffJson and shapes every mismatch into the report record the whole
 * suite prints: which scenario/endpoint it came from, the JSON path, and
 * both runtimes' values.
 */
function compareResponses({ scenario, endpoint, expectedNode, actualSpring, ignorePaths = [] }) {
  return diffJson(expectedNode, actualSpring, { ignorePaths }).map((m) => ({
    scenario,
    endpoint,
    path: m.path,
    expected: m.expectedNode,
    actual: m.actualSpring
  }));
}

/** Same shape, for a single named value (e.g. one header) rather than a full body. */
function compareValue({ scenario, endpoint, path, expectedNode, actualSpring }) {
  if (deepEqualPrimitive(expectedNode, actualSpring)) return [];
  return [{ scenario, endpoint, path, expected: expectedNode, actual: actualSpring }];
}

/** The repeated "assert the two responses' status AND body both match"
 *  pattern used across every scenario file — bundles a compareValue on
 *  $.status with a compareResponses on the body. */
function compareStatusAndBody({ scenario, endpoint, expectedNodeRes, actualSpringRes, ignorePaths = [] }) {
  return [
    ...compareValue({ scenario, endpoint, path: '$.status', expectedNode: expectedNodeRes.status, actualSpring: actualSpringRes.status }),
    ...compareResponses({ scenario, endpoint, expectedNode: expectedNodeRes.body, actualSpring: actualSpringRes.body, ignorePaths })
  ];
}

/**
 * Independent, per-runtime security assertion — NOT a Node-vs-Spring diff.
 *
 * A plain compareValue/compareResponses on two runtimes' responses to a
 * security-relevant probe (a missing/tampered receipt, an oversized body, a
 * bad bearer token) can only ever prove the two AGREE — if both runtimes
 * shared the same regression (e.g. neither rejected a tampered receipt),
 * the diff would report a clean "match" and hide a real vulnerability. This
 * asserts the actual required outcome against EACH runtime independently
 * (Node is not assumed correct here any more than Spring is), so a shared
 * failure surfaces as a mismatch even when the two runtimes still "agree".
 */
function assertRuntimeStatus({ scenario, endpoint, nodeStatus, springStatus, isAcceptable, labelA = 'first call, independent check', labelB = 'second call, independent check' }) {
  const mismatches = [];
  if (!isAcceptable(nodeStatus)) {
    mismatches.push({ scenario, endpoint, path: `$.status (${labelA})`, expected: 'status satisfying the security contract', actual: nodeStatus });
  }
  if (!isAcceptable(springStatus)) {
    mismatches.push({ scenario, endpoint, path: `$.status (${labelB})`, expected: 'status satisfying the security contract', actual: springStatus });
  }
  return mismatches;
}

module.exports = { diffJson, compareResponses, compareValue, compareStatusAndBody, assertRuntimeStatus };
