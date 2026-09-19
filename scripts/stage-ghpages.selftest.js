#!/usr/bin/env node
/**
 * Regression coverage for scripts/stage-ghpages.js.
 *
 * Plain Node + `assert`, matching this directory's convention (see
 * verify-no-bank-in-artifact.test.js). Named `.selftest.js`, not `.test.js`, so
 * Jest's default matcher does not collect it as an (assertion-less) suite. Run directly:
 *
 *   node scripts/stage-ghpages.selftest.js
 *
 * Every scenario builds disposable fixture builds and throwaway git repos under
 * the OS temp dir — never the real repository, a real dist, or a real
 * gh-pages clone. The hostile settings below (core.autocrlf=true plus an
 * attribute file forcing `text eol=lf`) are what actually reproduces the
 * production incident, so the negative test proves the fixtures really do
 * corrupt bytes when staged naively.
 */

const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { stage, verifyStaged, verifyBuildManifest, gitBlobId, sha1 } = require('./stage-ghpages');

const cases = [];
const cleanup = [];
function test(name, fn) { cases.push({ name, fn }); }

function tmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}
const git = (cwd, args) => {
  const r = cp.spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

const CRLF_SVG = Buffer.from('<svg>\r\n  <path d="M0 0"/>\r\n</svg>\r\n');
const CRLF_MANIFEST = Buffer.from('{\r\n  "name": "app"\r\n}\r\n');
// A binary that happens to contain CR and NUL bytes — must round-trip untouched too.
const BINARY = Buffer.from([0x89, 0x50, 0x0d, 0x0a, 0x00, 0x1a, 0x0d, 0x0a, 0xff]);

/** A miniature production build whose ngsw.json is correct for the bytes as written. */
function makeBuild({ corruptHash = false } = {}) {
  const dir = tmp('ghp-build-');
  const files = {
    'index.html': Buffer.from('<!doctype html><html><head><base href="/app/"></head><body></body></html>\n'),
    'main-ABC.js': Buffer.from('console.log(1);\n'),
    'assets/images/a.svg': CRLF_SVG,
    'manifest.webmanifest': CRLF_MANIFEST,
    'icons/icon.png': BINARY
  };
  const hashTable = {};
  for (const [rel, buf] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), buf);
    hashTable['/app/' + rel] = sha1(buf);
  }
  if (corruptHash) hashTable['/app/assets/images/a.svg'] = '0'.repeat(40);
  fs.writeFileSync(path.join(dir, 'ngsw.json'), JSON.stringify({ hashTable }));
  return dir;
}

/** A gh-pages-like clone under settings that corrupt CRLF files when staged naively. */
function makeHostileClone() {
  const dir = tmp('ghp-clone-');
  git(dir, ['init', '-q']);
  const attrs = path.join(tmp('ghp-attrs-'), 'attributes');
  fs.writeFileSync(attrs, '* text eol=lf\n');
  git(dir, ['config', 'core.autocrlf', 'true']);
  git(dir, ['config', 'core.attributesFile', attrs.split(path.sep).join('/')]);
  fs.writeFileSync(path.join(dir, 'stale-old-chunk.js'), 'old\n');   // a leftover from a previous deploy
  return dir;
}

// ── gitBlobId ─────────────────────────────────────────────────────────

test('gitBlobId matches `git hash-object --no-filters` for CRLF, binary and empty content', () => {
  const dir = tmp('ghp-hash-');
  git(dir, ['init', '-q']);
  for (const [name, buf] of [['crlf', CRLF_SVG], ['bin', BINARY], ['empty', Buffer.alloc(0)]]) {
    const f = path.join(dir, name);
    fs.writeFileSync(f, buf);
    assert.equal(gitBlobId(buf), git(dir, ['hash-object', '--no-filters', f]).trim(), name);
  }
});

// ── verifyBuildManifest ───────────────────────────────────────────────

test('a consistent build passes its own manifest', () => {
  const { checked, failures } = verifyBuildManifest(makeBuild());
  assert.deepEqual(failures, []);
  assert.equal(checked, 5);
});

test('a build file that no longer matches its ngsw.json hash is reported', () => {
  const { failures } = verifyBuildManifest(makeBuild({ corruptHash: true }));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /FAILS ITS OWN ngsw\.json HASH: assets\/images\/a\.svg/);
});

// ── the incident ──────────────────────────────────────────────────────

test('REPRODUCTION: naive `git add` under autocrlf=true + eol=lf attribute corrupts the CRLF files, and the gate catches exactly those', () => {
  const build = makeBuild();
  const clone = makeHostileClone();
  fs.rmSync(path.join(clone, 'stale-old-chunk.js'));
  fs.cpSync(build, clone, { recursive: true });
  fs.copyFileSync(path.join(clone, 'index.html'), path.join(clone, '404.html'));
  fs.writeFileSync(path.join(clone, '.nojekyll'), '');
  git(clone, ['add', '-A']);   // what the manual procedure did before

  const { failures } = verifyStaged(clone, build);
  const differs = failures.filter((f) => f.startsWith('STAGED BLOB DIFFERS'));
  assert.ok(differs.some((f) => f.includes('assets/images/a.svg')), failures.join('\n'));
  assert.ok(differs.some((f) => f.includes('manifest.webmanifest')), failures.join('\n'));
  assert.ok(failures.some((f) => f.startsWith('STAGED FILE FAILS ngsw.json HASH')), 'the service-worker hash check must fail too');
  assert.ok(!differs.some((f) => f.includes('main-ABC.js')), 'LF-only files are unaffected');
  // (A forced `text eol=lf` attribute also rewrites the binary's CR/LF pairs; the gate must catch that as well.)
  assert.ok(differs.some((f) => f.includes('icons/icon.png')), failures.join('\n'));
});

test('stage() under the SAME hostile settings stages every file byte-for-byte and passes the gate', () => {
  const build = makeBuild();
  const clone = makeHostileClone();
  const result = stage(clone, build);
  assert.deepEqual(result.failures, []);
  assert.equal(result.post.stagedCount, 8);            // 6 build files (incl. ngsw.json) + 404.html + .nojekyll
  assert.equal(result.post.manifestChecked, 5);

  // Independent of the script's own check: read the staged blobs straight from Git.
  const staged = (p) => cp.spawnSync('git', ['cat-file', 'blob', `:${p}`], { cwd: clone }).stdout;
  assert.ok(staged('assets/images/a.svg').equals(CRLF_SVG), 'CRLF svg must keep its CRLF');
  assert.ok(staged('manifest.webmanifest').equals(CRLF_MANIFEST), 'CRLF manifest must keep its CRLF');
  assert.ok(staged('icons/icon.png').equals(BINARY));
  assert.ok(staged('404.html').equals(fs.readFileSync(path.join(build, 'index.html'))), '404.html is a byte copy of index.html');
});

test('stage() removes leftovers from a previous deployment (staged set is exactly build + 404.html + .nojekyll)', () => {
  const build = makeBuild();
  const clone = makeHostileClone();
  assert.ok(fs.existsSync(path.join(clone, 'stale-old-chunk.js')));
  const result = stage(clone, build);
  assert.deepEqual(result.failures, []);
  assert.ok(!fs.existsSync(path.join(clone, 'stale-old-chunk.js')));
  assert.equal(git(clone, ['ls-files']).split('\n').includes('stale-old-chunk.js'), false);
});

// ── the gate's other failure modes ────────────────────────────────────

test('verifyStaged reports a missing file and an unexpected extra file', () => {
  const build = makeBuild();
  const clone = makeHostileClone();
  stage(clone, build);
  git(clone, ['rm', '-q', '--cached', 'main-ABC.js']);
  fs.writeFileSync(path.join(clone, 'extra.txt'), 'x');
  git(clone, ['-c', 'core.autocrlf=false', 'add', 'extra.txt']);
  const { failures } = verifyStaged(clone, build);
  assert.ok(failures.includes('NOT STAGED: main-ABC.js'), failures.join('\n'));
  assert.ok(failures.includes('UNEXPECTED STAGED FILE: extra.txt'), failures.join('\n'));
});

// ── refusals (nothing is wiped) ───────────────────────────────────────

test('stage() refuses a directory that is not a git clone', () => {
  assert.throws(() => stage(tmp('ghp-nogit-'), makeBuild()), /not a git clone/);
});

test('stage() refuses to wipe something that looks like a source checkout', () => {
  const clone = makeHostileClone();
  fs.writeFileSync(path.join(clone, 'package.json'), '{}');
  assert.throws(() => stage(clone, makeBuild()), /source checkout/);
  assert.ok(fs.existsSync(path.join(clone, 'package.json')), 'nothing may be deleted on refusal');
});

test('stage() aborts BEFORE touching the clone when the build fails its own ngsw.json', () => {
  const clone = makeHostileClone();
  const result = stage(clone, makeBuild({ corruptHash: true }));
  assert.equal(result.phase, 'build-manifest');
  assert.ok(result.failures.length > 0);
  assert.ok(fs.existsSync(path.join(clone, 'stale-old-chunk.js')), 'the clone must be left exactly as it was');
});

test('stage() refuses a directory that is not a production build', () => {
  assert.throws(() => stage(makeHostileClone(), tmp('ghp-notbuild-')), /not a production build/);
});

// ── run ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
for (const { name, fn } of cases) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    console.error(`FAIL: ${name}`);
    console.error(err && err.message ? err.message : err);
  }
}
for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed (${cases.length} total)`);
if (failed > 0) process.exit(1);
