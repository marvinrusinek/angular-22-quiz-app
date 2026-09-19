# GitHub Pages deployment

The site is served from the `gh-pages` branch. Deployment is manual and forward-only
(never force-push `gh-pages`; the previous head is the rollback point).

## Why staging is byte-exact

Angular's service worker (`ngsw.json`) records a SHA-1 of the exact bytes of every file in
the build and refuses to run normally if a served file differs. On Windows, Git for Windows
ships `core.autocrlf=true`, so committing a build that contains CRLF text files rewrites them
to LF. `manifest.webmanifest` and five SVGs (`angular`, `backpack`, `email`, `performance`,
`twitter`) are CRLF in this checkout, so their served bytes stopped matching `ngsw.json` and
the worker degraded to `EXISTING_CLIENTS_ONLY` ("Hash mismatch"). This affected every
deployment up to and including `06fd15b`.

`git -c core.autocrlf=false` is sufficient only while no Git attribute (`text`, `text=auto`,
`eol=lf`) applies, because an attribute overrides that flag. `scripts/stage-ghpages.js`
therefore neutralises conversion at the highest-precedence attribute source
(`$GIT_DIR/info/attributes`), stages, and then **refuses to continue** unless every staged
blob is byte-identical to the build and every `ngsw.json` hash matches the staged bytes.

## Procedure

Use a short-path clone (e.g. `C:/ghp10`); deep paths break `ngh` on Windows.

1. Sync the clone (do this before staging):
   `git fetch origin gh-pages && git reset --hard origin/gh-pages` (in the clone). Note the
   resulting head: it is the rollback point.
2. Build from the exact `main` commit being deployed, from the repository root:
   ```
   rm -rf dist
   node node_modules/@angular/cli/bin/ng.js build --configuration=production
   npm run verify:artifact
   ```
   Require exit code 0. On this Windows machine the build intermittently exits 139 (a
   segmentation fault) *after* Angular reports "Application bundle generation complete" and
   has written its output. It has been observed with both `npx ng build` and the direct
   `node …/ng.js` command; the cause is not identified. Treat any non-zero exit as a failed
   build: delete `dist` and rebuild until the exit code is 0. Never deploy output from a run
   that exited non-zero, even though the files look complete.
3. Stage and verify: `npm run stage:ghpages -- --clone C:/ghp10`. It wipes the clone's working
   tree, copies the build, adds `404.html` and `.nojekyll`, stages, and prints PASS or exits
   non-zero. **Do not commit on a non-zero exit.** It never commits or pushes.
4. Commit and push (fast-forward only):
   ```
   git commit -m "deploy: <main sha> - <main commit subject>"
   git push origin HEAD:gh-pages
   ```
5. After propagation, check the live worker: fetch `<site>/ngsw/state` from a page the worker
   controls and expect `Driver state: NORMAL`. A degraded state means a served file differs
   from its `ngsw.json` hash.

`npm run deploy` (`ngh`) stages through its own internal clone and is **not** covered by this
protection; prefer the procedure above on Windows.

Self-test for the staging tool: `npm run stage:ghpages:selftest`.
