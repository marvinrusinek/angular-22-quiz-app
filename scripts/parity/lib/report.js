'use strict';

// Defense in depth: a mismatch's path is normally a harmless field like
// `$.percentage`, but if a future scenario ever diffs a body that still
// carries a token/secret/receipt (a bug in that scenario, not something this
// report should trust it avoided), the VALUE at a path whose last segment
// looks sensitive is redacted before it ever reaches stdout — normal output
// and failure diagnostics alike.
const SENSITIVE_KEY_PATTERN = /(token|secret|receipt|password|authorization|tokenhash)$/i;

function redactIfSensitive(path, value) {
  const lastSegment = String(path).split(/[.[]/).pop()?.replace(/]$/, '') ?? '';
  return SENSITIVE_KEY_PATTERN.test(lastSegment) ? '[REDACTED]' : value;
}

/** Pretty-prints every mismatch (runtime pair is implicit: Node vs Spring
 *  throughout this suite — see compare.js), plus a final pass/fail summary. */
function printReport(scenarioResults) {
  let totalMismatches = 0;

  for (const { scenario, mismatches, notes } of scenarioResults) {
    const status = mismatches.length === 0 ? 'PASS' : 'FAIL';
    console.log(`\n[${status}] ${scenario} (${mismatches.length} mismatch${mismatches.length === 1 ? '' : 'es'})`);
    for (const note of notes ?? []) console.log(`  note: ${note}`);
    for (const m of mismatches) {
      console.log(`  MISMATCH  endpoint=${m.endpoint}  path=${m.path}`);
      console.log(`    expected (Node)  : ${JSON.stringify(redactIfSensitive(m.path, m.expected))}`);
      console.log(`    actual   (Spring): ${JSON.stringify(redactIfSensitive(m.path, m.actual))}`);
    }
    totalMismatches += mismatches.length;
  }

  console.log(`\n=== PARITY SUMMARY ===`);
  for (const { scenario, mismatches } of scenarioResults) {
    console.log(`  ${mismatches.length === 0 ? 'PASS' : 'FAIL'}  ${scenario}`);
  }
  console.log(`Total mismatches: ${totalMismatches}`);

  return totalMismatches === 0;
}

module.exports = { printReport };
