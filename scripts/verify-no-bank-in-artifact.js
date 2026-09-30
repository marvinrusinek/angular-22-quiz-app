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
 *   - a NON-EMPTY array/object/string starting with a quote (single or
 *     double) or a digit for the data-bearing aliases (`correctOptionIds: []`
 *     is the legitimate scrub/durable shape and must not match;
 *     `correctOptionIds: e` — a bare identifier/property read — structurally
 *     cannot match either, since there is no literal-opening character right
 *     after the colon).
 * `correctAnswers`/`correct_answers` additionally need a word boundary after
 * the name so this never fires on the unrelated, legitimate
 * `correctAnswersCount`/`correctAnswersText` identifiers already used
 * throughout the scoreboard/statistics code. Every marker below requires a
 * colon to appear IMMEDIATELY (mod whitespace) after the name — this is also
 * what keeps `isCorrectlyFormatted:`/`answerKeyword:`-style unrelated
 * identifiers from matching, with no separate check needed: `\s*:` simply
 * never matches against the extra trailing identifier characters.
 *
 * MINIFIED BOOLEANS — verified, not assumed: `{ correct: true }` does NOT
 * survive the real production minifier as `correct:true`. Checked directly
 * against esbuild (the minifier Angular's production builder uses) via a
 * synthetic fixture kept OUTSIDE this repo's tracked source: `true` becomes
 * `!0` and `false` becomes `!1`. Cross-checked against this repo's own real
 * `dist/demo/browser/main-*.js`: it contains zero occurrences of `:true` and
 * hundreds of `:!0`. So `!0` is matched everywhere `true` is, for `correct`,
 * `isCorrect`, and `is_correct` alike (their quoted-key JSON form can still
 * legitimately contain the word `true`, e.g. a re-added `assets/data/*.json`
 * bank, so that check is kept too, not replaced).
 *
 * `correct`'S OWN FALSE POSITIVE (found by running the widened check against
 * this repo's REAL dist/demo, not assumed away): unlike `isCorrect`/
 * `is_correct` (zero occurrences of `:true`/`:!0` anywhere in the real
 * bundle), the bare field name `correct` is ALSO the one the app's own LOCAL
 * verdict-computation code (`LocalTopicQuizVerdictAdapter` and its
 * `assignOptionActiveStates` helper — bundled, even though the DI-wired
 * production adapter is the API one) legitimately uses for a COMPUTED
 * RESULT, e.g. `{status:'resolved',correct:!0}` or
 * `{optionId:p.optionId,text:p.text,correct:!0}` — the latter's `text` value
 * is itself `p.text`, a property read, not a baked-in string. Requiring
 * `\bcorrect\s*:\s*(?:true|!0)\b` alone now matches these (it did not before
 * this change, only because it never recognised `!0` at all — this was a
 * pre-existing gap the new check made newly visible, not something this
 * change introduced). A REAL leaked bank entry always pairs `correct` with a
 * sibling `text` key whose OWN value is ALSO a literal quoted string (the
 * actual baked-in option text, e.g. `{text:"What is DI?",correct:true}`) —
 * that second literal is what the legitimate computed-result shapes above
 * never have (their `text`, when present at all, is a variable/property
 * read). So the `correct` boolean markers additionally require a literal
 * `text:"…"` (either quote style, quoted or unquoted key) within 120
 * characters before or after the match — verified against all 4 real
 * occurrences in this repo's own dist/demo (none now match) and against a
 * genuine leaked-bank-shape fixture (still matches). `isCorrect`/
 * `is_correct` keep the simple, unqualified check: verified to have zero
 * real-bundle occurrences today, and narrowing a check that isn't causing a
 * false positive would only reduce coverage without evidence it is needed.
 *
 * KNOWN REMAINING LIMIT (regex, not a parser — accepted, matching this
 * script's existing "defence in depth" scope): `!0`/`true` embedded inside a
 * larger boolean EXPRESSION rather than standing alone as the entire value
 * — e.g. `isCorrect: someFlag === true` or `isCorrect: !0 && check(x)` —
 * matches even though the actual assigned value is computed, not the literal
 * `true` itself. No occurrence of that shape exists anywhere in this app's
 * current source (verified by grep) or its real dist/demo output (verified
 * by inspection), and esbuild's own syntax minification would simplify a
 * literal `true && x`/`x === true` written directly in source before this
 * scanner ever sees it, so this is a theoretical edge rather than an
 * observed one — documented rather than "fixed" with a heavier parser this
 * script deliberately does not carry. The same caveat applies in principle
 * to `correct`'s new `text:"…"`-proximity requirement — a hypothetical bank
 * entry using a field name other than `text` for the option's display text
 * would not be caught by this specific refinement — but `text` is this
 * codebase's own actual, long-standing field name for it (see the existing
 * "hashed copy" self-test below), so this matches the shape that would
 * really reappear, not a hypothetical one.
 */
const ARRAY_LITERAL_START = '(?:"|\'|\\d)'; // a quoted string (either quote style) or a digit
const STRING_LITERAL = '(?:"[^"]+"|\'[^\']+\')'; // a non-empty quoted string, either quote style

// A literal `text:"…"` (or `"text":"…"`) key/value pair — real leaked bank
// option entries always carry one; legitimate computed-result code that
// happens to use the field name `correct` never has BOTH `correct` and a
// LITERAL (not variable/property-read) `text` value together.
const TEXT_LITERAL_KEY = '"?text"?\\s*:\\s*(?:"[^"]+"|\'[^\']+\')';
const TEXT_LITERAL_NEARBY_BEFORE = `(?<=${TEXT_LITERAL_KEY}[\\s\\S]{0,120})`;
const TEXT_LITERAL_NEARBY_AFTER = `(?=[\\s\\S]{0,120}${TEXT_LITERAL_KEY})`;

const ANSWER_KEY_ALIAS_ARRAY_NAMES = [
  'correctOptionIds', 'correct_option_ids',
  'expectedAnswers', 'expected_answers',
  'correctAnswers', 'correct_answers',
];

const CORRECTNESS_MARKERS = [
  // correct: true/!0 — quoted key, requires a literal text:"…" nearby.
  new RegExp(`${TEXT_LITERAL_NEARBY_BEFORE}"correct"\\s*:\\s*true`, 'i'),
  new RegExp(`"correct"\\s*:\\s*true${TEXT_LITERAL_NEARBY_AFTER}`, 'i'),
  new RegExp(`${TEXT_LITERAL_NEARBY_BEFORE}"correct"\\s*:\\s*!0\\b`, 'i'),
  new RegExp(`"correct"\\s*:\\s*!0\\b${TEXT_LITERAL_NEARBY_AFTER}`, 'i'),
  // correct: true/!0 — unquoted key, same requirement.
  new RegExp(`${TEXT_LITERAL_NEARBY_BEFORE}\\bcorrect\\s*:\\s*true\\b`),
  new RegExp(`\\bcorrect\\s*:\\s*true\\b${TEXT_LITERAL_NEARBY_AFTER}`),
  new RegExp(`${TEXT_LITERAL_NEARBY_BEFORE}\\bcorrect\\s*:\\s*!0\\b`),
  new RegExp(`\\bcorrect\\s*:\\s*!0\\b${TEXT_LITERAL_NEARBY_AFTER}`),

  /"correctCount"\s*:\s*\d+\s*,\s*"options"/i,
  /\bcorrectCount\s*:\s*\d+\s*,\s*options\s*:/,

  // isCorrect / is_correct — boolean literal, same shape as `correct`,
  // including the minified `!0` shorthand for `true`.
  /"isCorrect"\s*:\s*true/i,
  /"is_correct"\s*:\s*true/i,
  /\bisCorrect\s*:\s*true\b/,
  /\bis_correct\s*:\s*true\b/,
  /"isCorrect"\s*:\s*!0\b/i,
  /"is_correct"\s*:\s*!0\b/i,
  /\bisCorrect\s*:\s*!0\b/,
  /\bis_correct\s*:\s*!0\b/,

  // correctOptionIds / expectedAnswers / correctAnswers (+ snake_case) — a
  // NON-EMPTY array whose first element is a literal (either quote style, or
  // a digit), never a bare identifier/property read or an empty `[]`.
  ...ANSWER_KEY_ALIAS_ARRAY_NAMES.flatMap((name) => [
    new RegExp(`"${name}"\\s*:\\s*\\[\\s*${ARRAY_LITERAL_START}`, 'i'),
    new RegExp(`\\b${name}\\s*:\\s*\\[\\s*${ARRAY_LITERAL_START}`),
  ]),

  // answerKey / answer_key — may legitimately hold an object, an array, or a
  // string; same non-empty-literal requirement, either quote style.
  new RegExp(`"answerKey"\\s*:\\s*(?:\\{(?!\\s*\\})|\\[\\s*${ARRAY_LITERAL_START}|${STRING_LITERAL})`, 'i'),
  new RegExp(`"answer_key"\\s*:\\s*(?:\\{(?!\\s*\\})|\\[\\s*${ARRAY_LITERAL_START}|${STRING_LITERAL})`, 'i'),
  new RegExp(`\\banswerKey\\s*:\\s*(?:\\{(?!\\s*\\})|\\[\\s*${ARRAY_LITERAL_START}|${STRING_LITERAL})`),
  new RegExp(`\\banswer_key\\s*:\\s*(?:\\{(?!\\s*\\})|\\[\\s*${ARRAY_LITERAL_START}|${STRING_LITERAL})`),
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
