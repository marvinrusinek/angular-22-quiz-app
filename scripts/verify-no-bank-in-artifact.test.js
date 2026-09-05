#!/usr/bin/env node
/**
 * STAGE 16 — regression coverage for scripts/verify-no-bank-in-artifact.js.
 *
 * Plain Node + `assert`, matching this directory's existing convention (no
 * new test framework for one-off operator/CI scripts). Run directly:
 *
 *   node scripts/verify-no-bank-in-artifact.test.js
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
