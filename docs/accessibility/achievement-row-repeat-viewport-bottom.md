# Achievements: first row repeats near the viewport bottom (UNRESOLVED)

Status: **open. No confirmed cause and no reliable fix.**

Windows Narrator + Chrome, Topic Quiz Results (Summary Stats).

## Accepted release and deployment (2026-10-30)

- Source: [`0d906e32`](https://github.com/marvinrusinek/angular-22-quiz-app/commit/0d906e32f6d289a588910f093a3a97dc3433f550).
- GitHub Pages deployment: [`cd7dfd82`](https://github.com/marvinrusinek/angular-22-quiz-app/commit/cd7dfd82bf6a8d26753a5a5536b1e03b4e72a6bb).
- The release suppresses native list and list-item semantics on the catalog with
  `role="none"`, while preserving its visible title, description, status badge and layout.
- In manual testing of this accepted candidate, Narrator no longer announced "enter list"
  or "1 of 6", and Perfect Score did not repeat. The complete name, description and status
  were not read in one stop, and there was no single enclosing full-row highlight.
  That remaining limitation was accepted for this release; it is not a verified fix for
  every viewport position or Narrator navigation path.
- The release also includes the Introduction image's concise dynamic alt without a Tab
  stop, the combined Angular Fact accessible name, and single-text-node Summary Stats
  rows. The full release Jest run passed (232 suites, 3610 tests), and the production build
  exited successfully.
- Deployment verification reported that the public index and checked assets match the
  original build, including `main-LBKNXETM.js`. This does not verify live Narrator speech
  or highlight behavior; manual validation on GitHub Pages remains pending.
- The Perfect Score `role="group"`/`tabindex="0"` experiment
  (`e5a66cf0`, `wip/perfect-score-group-experiment-unverified`) and its subsequent local
  toggle-label edits are excluded from the release. The original WIP commits
  `c046d139` and `f281f8a6` remain on `wip/results-narrator-followup`, outside `main`.

The observations and failed candidates below record the earlier investigation and
experimental builds. They must not be read as a successful resolution or as one
uniform result across all builds.

## Earlier observations (manual)

- **Perfect Score** (the first achievement row) is announced **three times** when it is
  **partially visible at the bottom of the viewport**. Fully visible, it reads **once**.
- Other rows currently appear to read normally. That is a narrowed observation, not
  proof that other rows can never fail.
- Reported on Summary Stats; Score Analysis (same shared catalog component) reads once.

## What has been checked
- No app scroll handler or duplicate accessible element has been identified. Nothing in
  the app scrolls, focuses or listens when Narrator moves onto a row (source review of every
  `scrollTo` / `scrollBy` / `scrollIntoView` / `.focus()` call and all CSS; no
  `scroll-behavior`; no router scroll restoration).
- UI Automation recordings of a variant with named-graphic rows showed one childless element
  per row, no live regions and no events targeting the row.
- Viewport position alone has not been shown to be the cause.

## Candidates that did NOT resolve it
- Named-graphic rows (`role="img"` + `aria-label`), plain-text first row, styled first row,
  keyed catalog recreation, `ul`/`li` → `div`, `scroll-margin-bottom`.
- Hiding the Achievement Unlocked card's name/description list from assistive technology.
- An in-flow scroll indicator; an instant (non-smooth) scroll in `setActiveSection()`.

Those catalog and card experiments are kept on the `wip/results-narrator-followup` branch,
not in this release. Do not re-apply them as fixes. A new attempt needs a specific,
evidence-backed hypothesis.

## Related unresolved issue
Duplicated heading-level announcements around "Score Analysis":
see `topic-quiz-results-heading-level-repeat.md`. Open, cause undetermined.
