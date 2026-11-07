# Results page: always-visible Achievements catalog (demo fallback) — open announcement and highlight issues

**Status: the always-visible catalog is a demo fallback, and two Narrator issues remain OPEN.** Note dated 2026-11-06.

## What changed and why

The Achievements catalog on the Results page is now an always-visible section instead of a disclosure: a level-3 heading, "Achievements, N of M", followed by the six real achievement rows (earned and locked). There is no disclosure button, no `aria-expanded` and no chevron.

This is a **demo fallback**, chosen because the disclosure button's expansion announcement is spoken twice in Narrator Scan Mode in Chrome and Edge and could not be fixed page-side (see `achievements-toggle-narrator-expanded-twice.md`). Removing the disclosure interaction removes that announcement; it does not resolve the underlying Narrator/Chrome behavior.

The change also puts the sharing icons (Print, E-mail, Share on Twitter) back beside the Summary Stats heading, with each icon's glyph text exposed (links are named by `aria-label`), which is the placement and markup verified in manual Narrator checks.

Layout effect: the catalog section is about 395 px tall instead of 47 px, so content below it moves down about 348 px. The toggle's Tab stop is gone; the rows are named graphics and are not focusable.

## Open issue 1: "heading level 3" is spoken twice on the Achievements heading

With Narrator Scan Mode, on regular Chrome with a saved 6-of-6 result, reaching the heading is announced as "heading level 3 heading level 3 Achievements, 6 of 6".

Inspected, in the Summary Report view with a 6-of-6 fixture:

- Rendered DOM: one native `<h3>` containing a decorative (`aria-hidden`) trophy span and a title span with the text; no `role`, `aria-level`, `aria-label` or `aria-labelledby`.
- Chrome accessibility tree: one heading node, level 3, named "Achievements, 6 of 6". UIA: one heading element (control type Text, localized "heading", level 3), no children, one text line and one rectangle.
- Compared with the Summary Stats heading in the same view (an `<h2>`, text as a direct text node, two UIA text lines): measurable differences exist, but none explains a repeated level phrase.

Tried and discarded: putting "Achievements, N of M" directly in the `<h3>` as a text node (the title span removed, typography moved to the heading). The announcement was unchanged. No markup change is made for this issue.

## Open issue 2: the first sharing icon (Print) highlights differently from E-mail and Share

On the Results page, Print's highlight looks different from E-mail's and Share's. Measured on the actual page (Chrome, headed, keyboard modality, a UIA `SetFocus()` as an assistive technology does): the link that holds DOM focus is the one that shows an outline; it matches `:focus-visible`. In captured Narrator runs the first link Narrator reaches (Print) held UIA/DOM focus and the others did not, so only that link carried an outline. The three links' UIA element rectangles are the same size (about 60 x 68 physical pixels), so there is no geometric difference between them.

A rectangular `:focus-visible` outline (2 px, no radius) was prototyped and works for keyboard Tab focus and not for mouse clicks, but it is **not** part of this change: Narrator's own highlight cannot be captured while Narrator is off, so it is not yet established whether the difference the reporter sees is the page's focus ring or Narrator's highlight. The page's default focus ring is left untouched so visible keyboard focus is preserved.

## Not established

- Why Narrator repeats the heading level phrase.
- Whether Print's different highlight is the page's focus ring, Narrator's highlight, or both.
