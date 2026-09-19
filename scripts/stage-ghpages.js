#!/usr/bin/env node
/**
 * BYTE-EXACT GitHub Pages staging, with a hard verification gate.
 *
 * Why this exists: Angular's service worker hashes the exact bytes of every file
 * in the build (`ngsw.json`) and refuses to run if a served file differs. On
 * Windows, Git for Windows ships `core.autocrlf=true`, so committing a build
 * that contains CRLF text files (here: `manifest.webmanifest` and five SVGs)
 * silently rewrites them to LF. The served bytes then no longer match the
 * recorded hash and the worker degrades to EXISTING_CLIENTS_ONLY. `git -c
 * core.autocrlf=false` fixes the config case, but an attribute (`text`,
 * `eol=lf`, `text=auto`) overrides that flag, so this script does not rely on a
 * flag: it neutralises conversion at the highest-precedence attribute source
 * (`$GIT_DIR/info/attributes`) AND then refuses to continue unless every staged
 * blob is byte-identical to the verified build.
 *
 * What it does NOT do: commit or push. That stays a deliberate human step.
 *
 * Usage:
 *   node scripts/stage-ghpages.js --clone C:/ghp10 [--build dist/demo/browser]
 *   node scripts/stage-ghpages.js --clone C:/ghp10 --verify-only
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
/** The object id Git gives these exact bytes — computed without Git, so no filter or config can influence it. */
const gitBlobId = (buf) => sha1(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf]));

function git(cwd, args, { buffer = false } = {}) {
  const r = cp.spawnSync('git', args, { cwd, encoding: buffer ? 'buffer' : 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${String(r.stderr).trim()}`);
  return r.stdout;
}

function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name)).split(path.sep).join('/')]
  );
}

function basePrefix(buildDir) {
  const m = fs.readFileSync(path.join(buildDir, 'index.html'), 'utf8').match(/<base href="([^"]*)"/);
  return m ? m[1] : '/';
}

/** ngsw.json key ('/angular-22-quiz-app/main-X.js') -> path relative to the build root. */
function relFromNgswKey(key, prefix) {
  return key.startsWith(prefix) ? key.slice(prefix.length) : key.replace(/^\//, '');
}

/** Every entry in the build's own ngsw.json must match the build's own file bytes. */
function verifyBuildManifest(buildDir) {
  const failures = [];
  const ngsw = JSON.parse(fs.readFileSync(path.join(buildDir, 'ngsw.json'), 'utf8'));
  const prefix = basePrefix(buildDir);
  let checked = 0;
  for (const [key, expected] of Object.entries(ngsw.hashTable)) {
    const rel = relFromNgswKey(key, prefix);
    const file = path.join(buildDir, rel);
    if (!fs.existsSync(file)) { failures.push(`BUILD MISSING FILE: ${rel}`); continue; }
    checked++;
    if (sha1(fs.readFileSync(file)) !== expected) failures.push(`BUILD FILE FAILS ITS OWN ngsw.json HASH: ${rel}`);
  }
  return { checked, failures };
}

/**
 * The gate. Compares what is STAGED (the index — not the working tree) with the build:
 *   1. the staged set is exactly the build + 404.html + .nojekyll, nothing missing or extra;
 *   2. every staged blob is byte-identical to the build file (404.html == index.html);
 *   3. every ngsw.json hash matches the staged blob's own bytes.
 */
function verifyStaged(cloneDir, buildDir) {
  const failures = [];
  const staged = new Map();
  for (const rec of git(cloneDir, ['ls-files', '-s', '-z']).split('\0').filter(Boolean)) {
    const m = rec.match(/^\d+ ([0-9a-f]{40}) \d\t([\s\S]*)$/);
    staged.set(m[2], m[1]);
  }

  const expected = new Map();
  for (const rel of walk(buildDir)) expected.set(rel, gitBlobId(fs.readFileSync(path.join(buildDir, rel))));
  expected.set('404.html', expected.get('index.html'));
  expected.set('.nojekyll', EMPTY_BLOB);

  for (const [rel, blob] of expected) {
    if (!staged.has(rel)) failures.push(`NOT STAGED: ${rel}`);
    else if (staged.get(rel) !== blob) {
      const src = rel === '404.html' ? 'index.html' : rel;
      const buildBytes = rel === '.nojekyll' ? Buffer.alloc(0) : fs.readFileSync(path.join(buildDir, src));
      const stagedBytes = git(cloneDir, ['cat-file', 'blob', staged.get(rel)], { buffer: true });
      failures.push(`STAGED BLOB DIFFERS FROM BUILD BYTES: ${rel} (build ${buildBytes.length} bytes, staged ${stagedBytes.length} bytes)`);
    }
  }
  for (const rel of staged.keys()) if (!expected.has(rel)) failures.push(`UNEXPECTED STAGED FILE: ${rel}`);

  let manifestChecked = 0;
  if (staged.has('ngsw.json')) {
    const ngsw = JSON.parse(git(cloneDir, ['cat-file', 'blob', staged.get('ngsw.json')], { buffer: true }).toString('utf8'));
    const prefix = basePrefix(buildDir);
    for (const [key, hash] of Object.entries(ngsw.hashTable)) {
      const rel = relFromNgswKey(key, prefix);
      if (!staged.has(rel)) { failures.push(`ngsw.json NAMES A FILE THAT IS NOT STAGED: ${rel}`); continue; }
      manifestChecked++;
      if (sha1(git(cloneDir, ['cat-file', 'blob', staged.get(rel)], { buffer: true })) !== hash) {
        failures.push(`STAGED FILE FAILS ngsw.json HASH: ${rel}`);
      }
    }
  }
  return { stagedCount: staged.size, expectedCount: expected.size, manifestChecked, failures };
}

function stage(cloneDir, buildDir) {
  const clone = path.resolve(cloneDir);
  const build = path.resolve(buildDir);
  if (!fs.existsSync(path.join(clone, '.git'))) throw new Error(`${clone} is not a git clone (no .git)`);
  if (fs.existsSync(path.join(clone, 'package.json')) || fs.existsSync(path.join(clone, 'angular.json'))) {
    throw new Error(`${clone} looks like a source checkout, not a gh-pages clone — refusing to wipe it`);
  }
  for (const f of ['index.html', 'ngsw.json']) {
    if (!fs.existsSync(path.join(build, f))) throw new Error(`${build} is not a production build (no ${f})`);
  }

  const pre = verifyBuildManifest(build);
  if (pre.failures.length) return { phase: 'build-manifest', pre, failures: pre.failures };

  for (const name of fs.readdirSync(clone)) if (name !== '.git') fs.rmSync(path.join(clone, name), { recursive: true, force: true });
  fs.cpSync(build, clone, { recursive: true });
  fs.copyFileSync(path.join(clone, 'index.html'), path.join(clone, '404.html'));
  fs.writeFileSync(path.join(clone, '.nojekyll'), '');

  // Highest-precedence attribute source: beats any .gitattributes, global or system attribute file.
  const gitDir = path.resolve(clone, git(clone, ['rev-parse', '--git-dir']).trim());
  fs.mkdirSync(path.join(gitDir, 'info'), { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'info', 'attributes'), '* -text\n');

  git(clone, ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', 'add', '-A']);
  const post = verifyStaged(clone, build);
  return { phase: 'staged', pre, post, failures: post.failures };
}

function main() {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
  const clone = opt('--clone');
  const build = opt('--build', path.join('dist', 'demo', 'browser'));
  if (!clone) { console.error('usage: stage-ghpages.js --clone <gh-pages clone dir> [--build <dir>] [--verify-only]'); process.exit(2); }

  let result;
  try {
    result = args.includes('--verify-only')
      ? (() => { const pre = verifyBuildManifest(path.resolve(build)); const post = verifyStaged(path.resolve(clone), path.resolve(build)); return { phase: 'verify-only', pre, post, failures: [...pre.failures, ...post.failures] }; })()
      : stage(clone, build);
  } catch (err) {
    console.error(`[ghpages] ERROR: ${err.message}`);
    process.exit(2);
  }

  if (result.failures.length) {
    console.error(`\n[ghpages] FAIL (${result.failures.length}) — do NOT commit this deployment:\n`);
    for (const f of result.failures) console.error(`  - ${f}`);
    console.error('');
    process.exit(1);
  }
  console.log(`[ghpages] PASS — build manifest ${result.pre.checked}/${result.pre.checked} entries match the build; ` +
    `${result.post.stagedCount} staged files are byte-identical to the build (${result.post.expectedCount} expected); ` +
    `${result.post.manifestChecked}/${result.post.manifestChecked} ngsw.json hashes match the STAGED blobs.`);
}

if (require.main === module) main();

module.exports = { stage, verifyStaged, verifyBuildManifest, gitBlobId, sha1, walk };
