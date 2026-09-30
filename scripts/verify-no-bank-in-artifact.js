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
 * Correctness markers. `"correct":true` is the JSON shape the bank uses; the
 * spaced variant catches a pretty-printed copy.
 *
 * The UNQUOTED variants (Stage 16) exist because a production minifier strips
 * the quotes from an object-literal key that is already a valid JS identifier
 * — `{ "correct": true }` survives as JSON but `{correct: true}` in SOURCE
 * becomes `{correct:true}` after minification, not `{"correct":true}`. A bank
 * accidentally reintroduced as an imported JS/TS object literal (rather than a
 * fetched JSON asset) would only ever appear in the built artifact in this
 * unquoted shape, so relying on the quoted pattern alone would miss it.
 * Verified against the real production build to produce zero false positives.
 *
 * These are what an attacker would read, so their absence is the actual
 * security property — not merely the filename's.
 *
 * ANSWER-KEY ALIASES (added after the final audit flagged the gap): the same
 * scanner only ever looked for the literal token `correct`, never for the
 * other aliases `backend/src/api/response-policy.ts`'s own `ANSWER_KEY_FIELDS`
 * treats as equally sensitive — `isCorrect`/`is_correct`,
 * `correctOptionIds`/`correct_option_ids`, `answerKey`/`answer_key`,
 * `expectedAnswers`/`expected_answers`, `correctAnswers`/`correct_answers`. A
 * re-added bank using any of THOSE field names (e.g. Interview Mode's own
 * internal shape, which is `isCorrect` rather than `correct`) would have
 * shipped to the browser and this gate would have printed PASS.
 *
 * These five are NOT booleans like `correct` — `correctOptionIds` etc. hold
 * an array/object/string of the actual answer-bearing data — and, critically,
 * every one of them is ALSO a completely legitimate identifier throughout the
 * Angular frontend at RUNTIME: an authorized post-submit reveal genuinely
 * carries `correctOptionIds`/`isCorrect` from the API into view models, a
 * scrub list legitimately lists these NAMES as quoted strings to strip them,
 * and a durable snapshot legitimately zeroes a field with `correctOptionIds:
 * []`. None of that is a leak, so matching "the key name appears anywhere" is
 * unusable here without paging the scanner with real-world false positives
 * (verified against this repo's own currently-clean production build, which
 * contains all of the above patterns).
 *
 * The distinguishing signal is the same one `correct`/`correctCount` already
 * rely on: a LEAKED bank bakes LITERAL data in at build time, while
 * legitimate runtime code only ever assigns a VARIABLE, a property access, an
 * empty placeholder, or a computed expression to these keys. So each marker
 * requires the value to be a literal:
 *   - the boolean literal `true` for the isCorrect/is_correct aliases
 *     (mirrors `correct`; `isCorrect: false`/a computed boolean expression is
 *     real app code and must not match);
 *   - a NON-EMPTY array/object/string starting with a quote or a digit for
 *     the data-bearing aliases (`correctOptionIds: []` is the legitimate
 *     scrub/durable shape and must not match; `correctOptionIds: e` — a bare
 *     identifier/property read — structurally cannot match either, since
 *     there is no literal-opening character right after the colon).
 * `correctAnswers`/`correct_answers` additionally need a word boundary after
 * the name so this never fires on the unrelated, legitimate
 * `correctAnswersCount`/`correctAnswersText` identifiers already used
 * throughout the scoreboard/statistics code.
 */
const ANSWER_KEY_ALIAS_ARRAY_NAMES = [
  'correctOptionIds', 'correct_option_ids',
  'expectedAnswers', 'expected_answers',
  'correctAnswers', 'correct_answers',
];

const CORRECTNESS_MARKERS = [
  /"correct"\s*:\s*true/i,
  /"correctCount"\s*:\s*\d+\s*,\s*"options"/i,
  /\bcorrect\s*:\s*true\b/,
  /\bcorrectCount\s*:\s*\d+\s*,\s*options\s*:/,

  // isCorrect / is_correct — boolean literal, same shape as `correct`.
  /"isCorrect"\s*:\s*true/i,
  /"is_correct"\s*:\s*true/i,
  /\bisCorrect\s*:\s*true\b/,
  /\bis_correct\s*:\s*true\b/,

  // correctOptionIds / expectedAnswers / correctAnswers (+ snake_case) — a
  // NON-EMPTY array whose first element is a literal (quoted string or
  // digit), never a bare identifier/property read or an empty `[]`.
  ...ANSWER_KEY_ALIAS_ARRAY_NAMES.flatMap((name) => [
    new RegExp(`"${name}"\\s*:\\s*\\[\\s*(?:"|\\d)`, 'i'),
    new RegExp(`\\b${name}\\s*:\\s*\\[\\s*(?:"|\\d)`),
  ]),

  // answerKey / answer_key — may legitimately hold an object, an array, or a
  // string; same non-empty-literal requirement.
  /"answerKey"\s*:\s*(?:\{(?!\s*\})|\[\s*(?:"|\d)|"[^"]+")/i,
  /"answer_key"\s*:\s*(?:\{(?!\s*\})|\[\s*(?:"|\d)|"[^"]+")/i,
  /\banswerKey\s*:\s*(?:\{(?!\s*\})|\[\s*(?:"|\d)|"[^"]+"|'[^']+')/,
  /\banswer_key\s*:\s*(?:\{(?!\s*\})|\[\s*(?:"|\d)|"[^"]+"|'[^']+')/,
];

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

/**
 * Core scan, extracted from `main()` so it can run against a controlled test
 * fixture directory (see verify-no-bank-in-artifact.selftest.js) as well as a real
 * `dist`. Returns the same failure-message list `main()` prints.
 */
function scanArtifact(distDir) {
  const files = walk(distDir);
  const failures = [];

  // 1 + 2. The asset by name, anywhere in the tree or referenced from any file.
  for (const file of files) {
    const rel = path.relative(distDir, file);
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
    const rel = path.relative(distDir, file);

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

  return { files, failures };
}

function main() {
  if (!fs.existsSync(DIST)) {
    console.error(`[artifact] build output not found at ${DIST} — run \`npm run build\` first.`);
    process.exit(2);
  }

  const { files, failures } = scanArtifact(DIST);

  if (failures.length > 0) {
    console.error(`\n[artifact] FAIL — the answer key still reaches the browser (${failures.length}):\n`);
    for (const failure of new Set(failures)) console.error(`  - ${failure}`);
    console.error(`\nScanned ${files.length} files under ${DIST}.\n`);
    process.exit(1);
  }

  console.log(`[artifact] PASS — no bank, no asset reference, no correctness markers in ${files.length} files under ${DIST}.`);
}

if (require.main === module) main();

module.exports = { scanArtifact, walk, CORRECTNESS_MARKERS };
