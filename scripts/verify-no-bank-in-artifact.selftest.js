#!/usr/bin/env node
/**
 * STAGE 16 — regression coverage for scripts/verify-no-bank-in-artifact.js.
 *
 * Plain Node + `assert`, matching this directory's existing convention (no
 * new test framework for one-off operator/CI scripts). Run directly:
 *
 *   node scripts/verify-no-bank-in-artifact.selftest.js
 *
 * Builds small, disposable fixture directories under a temp dir — never the
 * real repository or a real `dist` — so each scenario is deterministic and
 * self-contained. Every fixture is removed at the end, pass or fail.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { scanArtifact } = require('./verify-no-bank-in-artifact');

const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

function makeFixtureDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-verify-fixture-'));
}
function write(dir, relPath, content) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

// ── Legitimate artifact shapes, all must PASS ────────────────────────────

test('a clean artifact (ordinary app code, no bank) passes', () => {
  const dir = makeFixtureDir();
  write(dir, 'main.js', 'console.log("Angular is running in development mode.");');
  write(dir, 'index.html', '<html><body>ok</body></html>');
  write(dir, 'ngsw.json', JSON.stringify({ assetGroups: [{ name: 'app' }] }));
  const { failures } = scanArtifact(dir);
  assert.deepEqual(failures, []);
});

test('legitimate app code using the word "correct" in prose/status text passes', () => {
  const dir = makeFixtureDir();
  write(dir, 'chunk.js', 'var msg = "That\\u2019s correct! Please select 2 more correct answers.";');
  const { failures } = scanArtifact(dir);
  assert.deepEqual(failures, []);
});

// ── Regressions this suite must catch (RED without the fix that removed
//    them from the app; GREEN here proves the verifier still catches each
//    one if it ever came back) ────────────────────────────────────────────

test('a re-added assets/data/quiz.json is caught by filename, anywhere in the tree', () => {
  const dir = makeFixtureDir();
  write(dir, 'assets/data/quiz.json', '{"quizzes":[]}');
  const { failures } = scanArtifact(dir);
  assert.ok(failures.some((f) => f.startsWith('SHIPPED ASSET:') && f.includes('quiz.json')));
});

test('a hashed copy of the asset (e.g. quiz.a1b2c3.json renamed FROM quiz.json) is NOT matched by the exact filename — this is why the content scan exists', () => {
  // Documents the known limitation of the filename check alone: Angular's
  // static "assets" glob copies files verbatim (unhashed), so in practice a
  // re-added quiz.json is caught by name. This case exists to prove the
  // CONTENT-based checks below are what actually close the gap for any
  // renamed/relocated copy, not the filename check.
  const dir = makeFixtureDir();
  write(dir, 'assets/data/renamed-bank.json', JSON.stringify({
    quizzes: [{ quizId: 'x', questions: [{ options: [{ text: 'a', correct: true }] }] }]
  }));
  const { failures } = scanArtifact(dir);
  assert.ok(!failures.some((f) => f.startsWith('SHIPPED ASSET:')), 'filename check correctly does not fire on a renamed file');
  assert.ok(failures.some((f) => f.startsWith('CORRECTNESS MARKER')), 'content scan catches it by shape instead');
});

test('a textual reference to the removed asset path is caught even with no correctness data', () => {
  const dir = makeFixtureDir();
  write(dir, 'chunk.js', 'fetch("assets/data/quiz.json").then(r => r.json());');
  const { failures } = scanArtifact(dir);
  assert.ok(failures.some((f) => f.startsWith('REFERENCES THE ASSET:')));
});

test('a QUOTED correctness marker ("correct":true, JSON shape) is caught', () => {
  const dir = makeFixtureDir();
  write(dir, 'data.json', '{"options":[{"text":"a","correct":true}]}');
  const { failures } = scanArtifact(dir);
  assert.ok(failures.some((f) => f.startsWith('CORRECTNESS MARKER')));
});

test('an UNQUOTED correctness marker (correct:true, the shape a JS minifier produces for a bundled object literal) is caught', () => {
  // THE STAGE 16 GAP: a real minifier drops quotes from a valid-identifier
  // object key. A private bank reintroduced as an imported JS/TS module
  // (rather than fetched JSON) would be minified into exactly this shape —
  // the pre-Stage-16 verifier only matched the quoted JSON form and missed it.
  const dir = makeFixtureDir();
  write(dir, 'chunk-abc123.js', 'var o={correct:true,text:"x"};');
  const { failures } = scanArtifact(dir);
  assert.ok(
    failures.some((f) => f.startsWith('CORRECTNESS MARKER')),
    'unquoted correct:true must be caught, not just the quoted JSON form'
  );
});

test('an unquoted correctCount/options shape is caught', () => {
  const dir = makeFixtureDir();
  write(dir, 'chunk.js', 'var q={correctCount:3,options:[]};');
  const { failures } = scanArtifact(dir);
  assert.ok(failures.some((f) => f.startsWith('CORRECTNESS MARKER')));
});

test('a non-scanned extension (e.g. an image) is never read as text, so binary content cannot false-positive', () => {
  const dir = makeFixtureDir();
  // Deliberately not valid UTF-8 / could contain byte sequences that look
  // like anything; must never be opened by the text scan.
  write(dir, 'assets/images/photo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  const { failures } = scanArtifact(dir);
  assert.deepEqual(failures, []);
});

// ── Answer-key ALIAS coverage (the gap the final audit flagged: the bank's
//    own `ANSWER_KEY_FIELDS` list has five aliases the scanner never checked
//    for) ──────────────────────────────────────────────────────────────────

test('a QUOTED "isCorrect":true marker (JSON shape) is caught', () => {
  const dir = makeFixtureDir();
  write(dir, 'data.json', '{"options":[{"text":"a","isCorrect":true}]}');
  const { failures } = scanArtifact(dir);
  assert.ok(failures.some((f) => f.startsWith('CORRECTNESS MARKER')));
});

test('an UNQUOTED isCorrect:true marker (post-minification JS shape) is caught', () => {
  const dir = makeFixtureDir();
  write(dir, 'chunk-abc123.js', 'var o={isCorrect:true,text:"x"};');
  const { failures } = scanArtifact(dir);
  assert.ok(failures.some((f) => f.startsWith('CORRECTNESS MARKER')));
});

test('a snake_case QUOTED "is_correct":true marker is caught', () => {
  const dir = makeFixtureDir();
  write(dir, 'data.json', '{"options":[{"text":"a","is_correct":true}]}');
  const { failures } = scanArtifact(dir);
  assert.ok(failures.some((f) => f.startsWith('CORRECTNESS MARKER')));
});

test('a QUOTED "correctOptionIds":[...] marker with real (literal) ids is caught', () => {
  const dir = makeFixtureDir();
  write(dir, 'data.json', '{"quizId":"x","correctOptionIds":[101,205]}');
  const { failures } = scanArtifact(dir);
  assert.ok(failures.some((f) => f.startsWith('CORRECTNESS MARKER')));
});

test('an UNQUOTED correctOptionIds:[...] marker with real (literal) ids is caught', () => {
  const dir = makeFixtureDir();
  write(dir, 'chunk.js', 'var q={correctOptionIds:[101,205],text:"x"};');
  const { failures } = scanArtifact(dir);
  assert.ok(failures.some((f) => f.startsWith('CORRECTNESS MARKER')));
});

test('a snake_case "correct_option_ids":[...] marker with string ids is caught', () => {
  const dir = makeFixtureDir();
  write(dir, 'data.json', '{"correct_option_ids":["a","b"]}');
  const { failures } = scanArtifact(dir);
  assert.ok(failures.some((f) => f.startsWith('CORRECTNESS MARKER')));
});

test('a QUOTED "answerKey" marker (object value) is caught', () => {
  const dir = makeFixtureDir();
  write(dir, 'data.json', '{"answerKey":{"q1":"a"}}');
  const { failures } = scanArtifact(dir);
  assert.ok(failures.some((f) => f.startsWith('CORRECTNESS MARKER')));
});

test('an UNQUOTED answerKey marker (string value) is caught', () => {
  const dir = makeFixtureDir();
  write(dir, 'chunk.js', 'var b={answerKey:"secret-answer",id:1};');
  const { failures } = scanArtifact(dir);
  assert.ok(failures.some((f) => f.startsWith('CORRECTNESS MARKER')));
});

test('a snake_case "answer_key" marker is caught', () => {
  const dir = makeFixtureDir();
  write(dir, 'data.json', '{"answer_key":["map"]}');
  const { failures } = scanArtifact(dir);
  assert.ok(failures.some((f) => f.startsWith('CORRECTNESS MARKER')));
});

test('an UNQUOTED expectedAnswers:[...] marker is caught', () => {
  const dir = makeFixtureDir();
  write(dir, 'chunk.js', 'var e={expectedAnswers:["map","filter"]};');
  const { failures } = scanArtifact(dir);
  assert.ok(failures.some((f) => f.startsWith('CORRECTNESS MARKER')));
});

test('a snake_case "expected_answers" marker is caught', () => {
  const dir = makeFixtureDir();
  write(dir, 'data.json', '{"expected_answers":[1,2]}');
  const { failures } = scanArtifact(dir);
  assert.ok(failures.some((f) => f.startsWith('CORRECTNESS MARKER')));
});

test('an UNQUOTED correctAnswers:[...] marker is caught', () => {
  const dir = makeFixtureDir();
  write(dir, 'chunk.js', 'var c={correctAnswers:[1,2],id:9};');
  const { failures } = scanArtifact(dir);
  assert.ok(failures.some((f) => f.startsWith('CORRECTNESS MARKER')));
});

test('a snake_case "correct_answers" marker is caught', () => {
  const dir = makeFixtureDir();
  write(dir, 'data.json', '{"correct_answers":["a"]}');
  const { failures } = scanArtifact(dir);
  assert.ok(failures.some((f) => f.startsWith('CORRECTNESS MARKER')));
});

// ── Benign runtime references that must NOT false-positive — every one of
//    these is a REAL shape already present in this app's own current,
//    audited, clean production bundle ─────────────────────────────────────

test('isCorrect:false (a real, non-leaking evaluation result) passes', () => {
  const dir = makeFixtureDir();
  write(dir, 'chunk.js', 'function evaluate(){return{isCorrect:false,count:0,answerIds:[]}}');
  const { failures } = scanArtifact(dir);
  assert.deepEqual(failures, []);
});

test('isCorrect assigned a COMPUTED expression (not a literal) passes', () => {
  const dir = makeFixtureDir();
  write(dir, 'chunk.js', 'var r={isCorrect:e.length>0&&t(e,n),other:1};');
  const { failures } = scanArtifact(dir);
  assert.deepEqual(failures, []);
});

test('correctOptionIds:[] — the legitimate scrubbed/durable-snapshot shape — passes', () => {
  const dir = makeFixtureDir();
  write(dir, 'chunk.js', 'var r={selectedOptionIds:[1,2],correctOptionIds:[]};');
  const { failures } = scanArtifact(dir);
  assert.deepEqual(failures, []);
});

test('correctOptionIds assigned a bare identifier/property read (real API data flowing through, not baked-in) passes', () => {
  const dir = makeFixtureDir();
  write(dir, 'chunk.js', 'var x={correctOptionIds:e.correctOptionIds,isCorrect:a&&b(e,e.correctOptionIds)};');
  const { failures } = scanArtifact(dir);
  assert.deepEqual(failures, []);
});

test('correctAnswersCount / correctAnswersText (unrelated real identifiers) never trigger the correctAnswers marker', () => {
  const dir = makeFixtureDir();
  write(dir, 'chunk.js', 'var s={correctAnswersCount:5,correctAnswersText:"5/10"};');
  const { failures } = scanArtifact(dir);
  assert.deepEqual(failures, []);
});

test('a quoted string ARRAY of field names (a scrub/allow-list, not key:value data) never triggers any alias marker', () => {
  const dir = makeFixtureDir();
  write(dir, 'chunk.js', 'var FORBIDDEN=["questions","options","correct","isCorrect","correctOptionIds","answerKey"];');
  const { failures } = scanArtifact(dir);
  assert.deepEqual(failures, []);
});

test('answerKey:{} (an empty placeholder object) passes', () => {
  const dir = makeFixtureDir();
  write(dir, 'chunk.js', 'var cfg={answerKey:{},id:1};');
  const { failures } = scanArtifact(dir);
  assert.deepEqual(failures, []);
});

// ── Follow-up: minified `!0` booleans + single-quoted array elements ──────
//
// Independent testing found both of these embedded-answer-data fixtures
// incorrectly PASSED the prior version of the scanner:
//   var q = { isCorrect: !0 };
//   var q = { correctOptionIds: ['a'] };
//
// Verified directly against esbuild — the same minifier Angular's production
// builder uses — via a synthetic fixture OUTSIDE this repo's tracked source
// (never committed): `{ correct: true }` minifies to `{correct:!0}`, and
// `{ correct: false }` to `{correct:!1}`. Cross-checked against this repo's
// OWN real dist/demo/browser/main-*.js: it contains 495 occurrences of
// `:!0` and ZERO of `:true`. So the ORIGINAL `correct:true` unquoted-JS
// marker (Stage 16) has apparently never matched a single real production
// bundle either — this was a pre-existing gap the new aliases only made
// newly visible, not something introduced by them.

test('minified !0 for "correct" (quoted key) is caught', () => {
  const dir = makeFixtureDir();
  write(dir, 'chunk.js', 'var q={"correct":!0,text:"x"};');
  const { failures } = scanArtifact(dir);
  assert.ok(failures.some((f) => f.startsWith('CORRECTNESS MARKER')));
});

test('minified !0 for correct (unquoted key) is caught', () => {
  const dir = makeFixtureDir();
  write(dir, 'chunk.js', 'var q={correct:!0,text:"x"};');
  const { failures } = scanArtifact(dir);
  assert.ok(failures.some((f) => f.startsWith('CORRECTNESS MARKER')));
});

test('minified !0 for "isCorrect" (quoted key) is caught', () => {
  const dir = makeFixtureDir();
  write(dir, 'chunk.js', 'var q={"isCorrect":!0};');
  const { failures } = scanArtifact(dir);
  assert.ok(failures.some((f) => f.startsWith('CORRECTNESS MARKER')));
});

test('minified isCorrect:!0 (unquoted key) is caught — the exact reported miss', () => {
  const dir = makeFixtureDir();
  write(dir, 'chunk.js', 'var q={isCorrect:!0};');
  const { failures } = scanArtifact(dir);
  assert.ok(failures.some((f) => f.startsWith('CORRECTNESS MARKER')));
});

test('minified !0 for "is_correct" (quoted key) is caught', () => {
  const dir = makeFixtureDir();
  write(dir, 'chunk.js', 'var q={"is_correct":!0};');
  const { failures } = scanArtifact(dir);
  assert.ok(failures.some((f) => f.startsWith('CORRECTNESS MARKER')));
});

test('minified is_correct:!0 (unquoted key) is caught', () => {
  const dir = makeFixtureDir();
  write(dir, 'chunk.js', 'var q={is_correct:!0};');
  const { failures } = scanArtifact(dir);
  assert.ok(failures.some((f) => f.startsWith('CORRECTNESS MARKER')));
});

test('minified isCorrect:!0 with extra whitespace around the colon/braces is still caught', () => {
  const dir = makeFixtureDir();
  write(dir, 'chunk.js', 'var q = { isCorrect  :  !0 , text : "x" };');
  const { failures } = scanArtifact(dir);
  assert.ok(failures.some((f) => f.startsWith('CORRECTNESS MARKER')));
});

test('correctOptionIds:[\'a\'] (single-quoted array element) is caught — the exact reported miss', () => {
  const dir = makeFixtureDir();
  write(dir, 'chunk.js', "var q={correctOptionIds:['a']};");
  const { failures } = scanArtifact(dir);
  assert.ok(failures.some((f) => f.startsWith('CORRECTNESS MARKER')));
});

test('correct_option_ids with single-quoted elements (snake_case) is caught', () => {
  const dir = makeFixtureDir();
  write(dir, 'chunk.js', "var q={correct_option_ids:['a','b']};");
  const { failures } = scanArtifact(dir);
  assert.ok(failures.some((f) => f.startsWith('CORRECTNESS MARKER')));
});

test('expectedAnswers with single-quoted elements is caught', () => {
  const dir = makeFixtureDir();
  write(dir, 'chunk.js', "var q={expectedAnswers:['map']};");
  const { failures } = scanArtifact(dir);
  assert.ok(failures.some((f) => f.startsWith('CORRECTNESS MARKER')));
});

test('expected_answers with single-quoted elements (snake_case) is caught', () => {
  const dir = makeFixtureDir();
  write(dir, 'chunk.js', "var q={expected_answers:['x']};");
  const { failures } = scanArtifact(dir);
  assert.ok(failures.some((f) => f.startsWith('CORRECTNESS MARKER')));
});

test('correctAnswers with single-quoted elements is caught', () => {
  const dir = makeFixtureDir();
  write(dir, 'chunk.js', "var q={correctAnswers:['a']};");
  const { failures } = scanArtifact(dir);
  assert.ok(failures.some((f) => f.startsWith('CORRECTNESS MARKER')));
});

test('correct_answers with single-quoted elements (snake_case) is caught', () => {
  const dir = makeFixtureDir();
  write(dir, 'chunk.js', "var q={correct_answers:['a']};");
  const { failures } = scanArtifact(dir);
  assert.ok(failures.some((f) => f.startsWith('CORRECTNESS MARKER')));
});

test('answerKey assigned a single-quoted string is caught', () => {
  const dir = makeFixtureDir();
  write(dir, 'chunk.js', "var b={answerKey:'single-quoted-secret',id:1};");
  const { failures } = scanArtifact(dir);
  assert.ok(failures.some((f) => f.startsWith('CORRECTNESS MARKER')));
});

test('answer_key (snake_case) assigned a single-quoted string is caught', () => {
  const dir = makeFixtureDir();
  write(dir, 'chunk.js', "var b={answer_key:'secret'};");
  const { failures } = scanArtifact(dir);
  assert.ok(failures.some((f) => f.startsWith('CORRECTNESS MARKER')));
});

test('answerKey assigned a single-quoted ARRAY is caught', () => {
  const dir = makeFixtureDir();
  write(dir, 'chunk.js', "var b={answerKey:['a','b']};");
  const { failures } = scanArtifact(dir);
  assert.ok(failures.some((f) => f.startsWith('CORRECTNESS MARKER')));
});

test('single-quoted array elements with extra whitespace throughout are still caught', () => {
  const dir = makeFixtureDir();
  write(dir, 'chunk.js', "var q = { correctOptionIds : [ 'a' , 'b' ] , text : 'x' };");
  const { failures } = scanArtifact(dir);
  assert.ok(failures.some((f) => f.startsWith('CORRECTNESS MARKER')));
});

// ── Additional benign/negative coverage for the new patterns above ────────

test('isCorrect:!1 (minified FALSE — a real, non-leaking evaluation result) passes', () => {
  const dir = makeFixtureDir();
  write(dir, 'chunk.js', 'function evaluate(){return{isCorrect:!1,count:0}}');
  const { failures } = scanArtifact(dir);
  assert.deepEqual(failures, []);
});

test('isCorrectlyFormatted / isCorrected (unrelated identifiers with "isCorrect" as a prefix) never trigger the isCorrect marker', () => {
  const dir = makeFixtureDir();
  write(dir, 'chunk.js', 'var x={isCorrectlyFormatted:!0,isCorrected:!0,other:1};');
  const { failures } = scanArtifact(dir);
  assert.deepEqual(failures, []);
});

test('correctOptionIdsList / answerKeyword (unrelated identifiers with an alias name as a prefix) never trigger any alias marker', () => {
  const dir = makeFixtureDir();
  write(dir, 'chunk.js', "var x={correctOptionIdsList:['a'],answerKeyword:'z'};");
  const { failures } = scanArtifact(dir);
  assert.deepEqual(failures, []);
});

// ── `correct`'s own false positive against this app's REAL local verdict
//    code — caught when this file's own scanner was first run against the
//    real dist/demo build with the widened !0 check above, BEFORE assuming
//    it was clean. Each fixture below is the exact shape found (or the same
//    shape, minimally reduced) in dist/demo/browser/chunk-*.js, from the
//    bundled (never DI-wired in production) LocalTopicQuizVerdictAdapter and
//    its assignOptionActiveStates() helper — genuine computed-result code,
//    never an embedded bank. These must stay green for `correct:!0`/
//    `correct:true` to remain usable at all. ─────────────────────────────

test('correct:!0 on a verdict-result object with NO text sibling (real shape: {status:\'resolved\',correct:!0}) passes', () => {
  const dir = makeFixtureDir();
  write(dir, 'chunk.js', "function check(){return{status:'resolved',correct:!0}}");
  const { failures } = scanArtifact(dir);
  assert.deepEqual(failures, []);
});

test('correct:!0 where the nearby "text" value is itself a property READ, not a literal (real shape: {text:p.text,correct:!0}) passes', () => {
  const dir = makeFixtureDir();
  write(dir, 'chunk.js', 'c.push(Y(Z({},l),{optionId:p.optionId,text:p.text,correct:!0}));');
  const { failures } = scanArtifact(dir);
  assert.deepEqual(failures, []);
});

test('a ternary ending in a property read (n.correct) immediately before a literal !0 branch (real shape: t?n.correct:!0) passes', () => {
  const dir = makeFixtureDir();
  write(dir, 'chunk.js', 'var r={active:t?n.correct:!0,feedback:t&&!n.correct?`x`:void 0};');
  const { failures } = scanArtifact(dir);
  assert.deepEqual(failures, []);
});

test('correct:true with no text anywhere in the file passes', () => {
  const dir = makeFixtureDir();
  write(dir, 'chunk.js', 'function r(){return{status:"resolved",correct:true}}');
  const { failures } = scanArtifact(dir);
  assert.deepEqual(failures, []);
});

test('a genuine leaked-bank shape with correct BEFORE a literal text (key order reversed from the usual fixture) is still caught', () => {
  const dir = makeFixtureDir();
  write(dir, 'chunk.js', 'var o={correct:true,text:"What is DI?"};');
  const { failures } = scanArtifact(dir);
  assert.ok(failures.some((f) => f.startsWith('CORRECTNESS MARKER')));
});

test('a genuine leaked-bank shape with correct:!0 and a literal text more than a few fields away is still caught (within the 120-char window)', () => {
  const dir = makeFixtureDir();
  write(dir, 'chunk.js', 'var o={optionId:3,displayOrder:1,text:"What is DI?",correct:!0};');
  const { failures } = scanArtifact(dir);
  assert.ok(failures.some((f) => f.startsWith('CORRECTNESS MARKER')));
});

// ── Runner ────────────────────────────────────────────────────────────────

let failed = 0;
for (const { name, fn } of cases) {
  try {
    fn();
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL - ${name}`);
    console.error(`    ${err.message}`);
  }
}

console.log(`\n${cases.length - failed}/${cases.length} passed`);
if (failed > 0) process.exit(1);
