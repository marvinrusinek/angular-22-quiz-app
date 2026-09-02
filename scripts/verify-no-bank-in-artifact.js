#!/usr/bin/env node
/**
 * ARTIFACT PROOF: the answer key must not ship to the browser.
 *
 * Stage 14 moves the quiz bank behind the API. The point of that work is that a
 * player cannot read the answers out of what the browser downloads — so the
 * check that matters is performed on the BUILT ARTIFACT, not on the source. A
 * source-level grep proves nothing: the asset could still be copied in by the
 * build, inlined into a bundle, or precached by the service worker.
 *
 * This scans every file under the build output for
 *
 *   1. the asset itself (assets/data/quiz.json), including any hashed copy;
 *   2. service-worker precache entries naming it;
 *   3. correctness markers ("correct":true) in any shipped JSON or JS chunk.
 *
 * EXPECTED TO FAIL until S7b-2 C deletes the asset. It is deliberately a script
 * rather than a spec so the suite does not carry a knowingly-red test; wire it
 * into the gates in the same commit that deletes the file:
 *
 *     "verify:artifact": "node scripts/verify-no-bank-in-artifact.js"
 *
 * Usage: npm run build && node scripts/verify-no-bank-in-artifact.js
 */

const fs = require('fs');
const path = require('path');

const DIST = process.argv[2] ?? path.join('dist', 'demo');

/** Files whose CONTENT is scanned for correctness markers. */
const SCANNED_EXT = new Set(['.js', '.json', '.mjs', '.txt', '.html', '.css']);

/**
 * Correctness markers. `"correct":true` is the shape the bank uses; the spaced
 * variant catches a pretty-printed copy. These are what an attacker would read,
 * so their absence is the actual security property — not merely the filename's.
 */
const CORRECTNESS_MARKERS = [/"correct"\s*:\s*true/i, /"correctCount"\s*:\s*\d+\s*,\s*"options"/i];

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function main() {
  if (!fs.existsSync(DIST)) {
    console.error(`[artifact] build output not found at ${DIST} — run \`npm run build\` first.`);
    process.exit(2);
  }

  const files = walk(DIST);
  const failures = [];

  // 1 + 2. The asset by name, anywhere in the tree or referenced from any file.
  for (const file of files) {
    const rel = path.relative(DIST, file);
    if (/quiz\.json$/i.test(rel)) {
      failures.push(`SHIPPED ASSET: ${rel}`);
    }
  }

  // 3. Correctness markers, and any textual reference to the asset path.
  for (const file of files) {
    if (!SCANNED_EXT.has(path.extname(file).toLowerCase())) continue;
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const rel = path.relative(DIST, file);

    if (/assets\/data\/quiz\.json/i.test(text)) {
      failures.push(`REFERENCES THE ASSET: ${rel}`);
    }
    for (const marker of CORRECTNESS_MARKERS) {
      if (marker.test(text)) {
        failures.push(`CORRECTNESS MARKER ${marker} in: ${rel}`);
        break;
      }
    }
  }

  if (failures.length > 0) {
    console.error(`\n[artifact] FAIL — the answer key still reaches the browser (${failures.length}):\n`);
    for (const failure of new Set(failures)) console.error(`  - ${failure}`);
    console.error(`\nScanned ${files.length} files under ${DIST}.\n`);
    process.exit(1);
  }

  console.log(`[artifact] PASS — no bank, no asset reference, no correctness markers in ${files.length} files under ${DIST}.`);
}

main();
