# Results page: always-visible Achievements catalog (demo fallback) — open announcement and highlight issues

**Status: the always-visible catalog is a demo fallback, and two Narrator issues remain OPEN.** Note dated 2026-11-06.

## What changed and why

The Achievements catalog on the Results page is now an always-visible section instead of a disclosure: a level-3 heading, "Achievements, N of M", followed by the six real achievement rows (earned and locked). There is no disclosure button, no `aria-expanded` and no chevron.

This is a **demo fallback**, chosen because the disclosure button's expansion announcement is spoken twice in Narrator Scan Mode in Chrome and Edge and could not be fixed page-side (see `achievements-toggle-narrator-expanded-twice.md`). Removing the disclosure interaction removes that announcement; it does not resolve the underlying Narrator/Chrome behavior.

The change also puts the sharing icons (Print, E-mail, Share on Twitter) back beside the Summary Stats heading, with each icon's glyph text exposed (links are named by `aria-label`), which is the placement and markup verified in manual Narrator checks.

The sharing icons also use Angular CDK `FocusMonitor` (see Open issue 2) so that focus set programmatically by assistive technology while Narrator reads leaves no extra app outline on Print; keyboard (Tab / Shift+Tab) focus keeps a standard outline.

Layout effect: the catalog section is about 395 px tall instead of 47 px, so content below it moves down about 348 px. The toggle's Tab stop is gone; the rows are named graphics and are not focusable.

## Open issue 1: "heading level 3" is spoken twice on the Achievements heading

With Narrator Scan Mode, on regular Chrome with a saved 6-of-6 result, reaching the heading is announced as "heading level 3 heading level 3 Achievements, 6 of 6".

Inspected, in the Summary Report view with a 6-of-6 fixture:

- Rendered DOM: one native `<h3>` containing a decorative (`aria-hidden`) trophy span and a title span with the text; no `role`, `aria-level`, `aria-label` or `aria-labelledby`.
- Chrome accessibility tree: one heading node, level 3, named "Achievements, 6 of 6". UIA: one heading element (control type Text, localized "heading", level 3), no children, one text line and one rectangle.
- Compared with the Summary Stats heading in the same view (an `<h2>`, text as a direct text node, two UIA text lines): measurable differences exist, but none explains a repeated level phrase.

Navigation-path and standalone results (2026-11-07, user-tested in Chrome with Narrator Scan Mode):

- On the Results page: Shift+H to the Achievements h3 says "Achievements 6 of 6 heading level 3" (level once); Down Arrow says "heading level 3 heading level 3 Achievements 6 of 6" (level twice). Same DOM and accessibility tree for both paths.
- Minimal standalone page (no app, no scripts, no CSS), served locally and saved on the author's machine as a11y-standalone-heading-h3/index.html:

  ```html
  <!doctype html>
  <html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Standalone h3 heading repro</title></head>
  <body>
  <p>Line before the heading.</p>
  <h3>Achievements, 6 of 6</h3>
  <p>Line after the heading.</p>
  </body>
  </html>
  ```

  Down Arrow onto the h3 says "heading level 3" TWICE. Shift+H says "wrapping to bottom Achievements 6 of 6 heading level 3" (the level once).
- Conclusion: the repeated level reproduces on a standalone native heading. This test does not establish whether Narrator, Chrome, or their interaction causes it. Because it happens outside the app on a single native h3, the Results heading keeps its correct semantics (one native h3) and is not changed.

Tried and discarded: putting "Achievements, N of M" directly in the `<h3>` as a text node (the title span removed, typography moved to the heading). The announcement was unchanged. No markup change is made for this issue.

## Open issue 2: the first sharing icon (Print) highlights differently from E-mail and Share

On the Results page, Print's highlight looks different from E-mail's and Share's. Measured on the actual page (Chrome, headed, keyboard modality, a UIA `SetFocus()` as an assistive technology does): the link that holds DOM focus is the one that shows an outline; it matches `:focus-visible`. In captured Narrator runs the first link Narrator reaches (Print) held UIA/DOM focus and the others did not, so only that link carried an outline. The three links' UIA element rectangles are the same size (about 60 x 68 physical pixels), so there is no geometric difference between them.

Change in this PR: the three sharing links are monitored with Angular CDK `FocusMonitor` (already used through Angular Material). A link gets `cdk-keyboard-focused` only when focus follows a keyboard event (Tab / Shift+Tab) and then shows a standard 2 px rectangular outline with a clear background; focus set programmatically (what assistive technology does) is tagged `cdk-program-focused` and shows no app outline. Forced colors use the `Highlight` color. Links stay in the Tab order, and names, actions and placement are unchanged. The user confirmed on regular localhost:4200 that, with Narrator Scan Mode Down Arrow through Print, E-mail and Share, the result matches the passing preview. Unit test: programmatic focus does not get the keyboard class, Tab-origin focus does.

Tried and rejected for Tab focus: a solid blue background, an inset bottom bar and four corner marks. None resolved the overlap below.

**Still unresolved: Tab / Shift+Tab with Narrator on.** The app's keyboard-focus outline can appear together with Narrator's own rectangle, which reads as a doubled border. The page cannot see Narrator's highlight, and removing the app outline would remove the standard visible keyboard-focus indicator when Narrator is off.

## Not established

- Whether Narrator, Chrome or their interaction causes the repeated heading level (it reproduces on a standalone native heading).
- How to avoid the Tab/Shift+Tab outline overlap with Narrator on while keeping a standard visible keyboard-focus indicator with Narrator off.
