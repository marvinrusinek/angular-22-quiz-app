# Achievements: first row repeats near the viewport bottom (UNRESOLVED)

Status: **open. No confirmed cause and no reliable fix.**

Windows Narrator + Chrome, Topic Quiz Results (Summary Stats).

## Observation (manual)
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
