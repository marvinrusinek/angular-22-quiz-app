# Achievements toggle — Narrator announces "expanded" twice, and splits the collapsed name

**Status: OPEN, unresolved. Cause undetermined.** Investigation note, 2026-11-05. No application behavior is changed by this note.

## Symptom

With Windows Narrator in Scan Mode, on the Achievements toggle (a native `<button aria-expanded>` named by one visible label, "Achievements, 6 of 6"):

- **Arrival** (Down Arrow onto the button): the collapsed name is read in pieces, as
  "button collapsed Achievements 6 of button collapsed 6".
- **One Space press**: the expanded announcement is spoken **twice**,
  "Achievements 6 of 6 button expanded".

The Perfect Score row that follows (next Down Arrow) is read in full with a rectangle around the whole row.

## It does not need the quiz app

A plain HTML page reproduces it: one line of text, then a native `<button type="button" aria-expanded="false">` whose only exposed text is one visible label span ("Achievements, 6 of 6"; the trophy and chevron are `aria-hidden`), and a panel of six rows added on click. No framework, no scroll logic, no timing logic. Sequence: Narrator on, Scan Mode on, Down Arrow to the text line, Down Arrow to the button, Space once.

The same wording was heard in a regular Chrome profile and in Incognito, and the app also still failed with browser extensions turned off.

## Environment

Windows 11 25H2 (build 26200.9711), Narrator.exe 10.0.26100.8972, Chrome 156.0.8078.80, Edge 156.0.4314.58, display scaling 250%, browser zoom 100%. Firefox 159.0.1 was installed but Down Arrow navigation to the button was blocked, so Firefox is untested.

## Results by test

| Test | Browser | Page | Result |
| --- | --- | --- | --- |
| Narrator Down Arrow → Space | Chrome | original standalone page | split name; "expanded" twice |
| Narrator Down Arrow → Space | Edge | original standalone page (earlier pass) | name read correctly; "expanded" once |
| Narrator Down Arrow → Space | Chrome | instrumented copy | split name; "expanded" twice (two passes) |
| Narrator Down Arrow → Space | Edge | instrumented copy | split name; "expanded" twice |

The Edge result therefore changed between the original page and the instrumented copy. It has not been attributed to Narrator variability.

The instrumented copy differs from the original **only** by (1) a " (logged)" suffix on the page title, which is also the document's accessible name, and (2) a passive script: capturing listeners on the button, a mutation observer on `aria-expanded`, a scroll listener, and fire-and-forget `sendBeacon` calls to a local receiver. The markup, label, styles and toggle script are byte-identical. These differences are unlikely to matter, but they have not been ruled out.

## What the actual-Narrator captures establish

Page-side (DOM) and UIA-side logs were recorded together on the instrumented copy, with a shared epoch-millisecond clock. The shape was the same in Chrome (two passes) and Edge (one pass), within a few milliseconds:

1. **Nothing is focused on arrival.** In the 6 seconds before Space there was no DOM focus, no UIA focus event and no text-selection event on the button.
2. **Space reaches the page as mouse events, not as a key.** Focus lands on the button; 6–16 ms later come `pointerdown` (pointer type mouse), `mousedown`, `pointerup`, `mouseup` and `click` (detail 1); `aria-expanded` changes from false to true 1 ms after the click. There is no `keydown` or `keyup` for Space.
3. **One click, one state change.** The page does not fire two clicks or two `aria-expanded` writes.
4. **UIA timing.** The UIA focus event reached the client 33–54 ms after the DOM focus, which is after the click and the `aria-expanded` write. The UIA `ExpandCollapseState` change followed 2–8 ms after the focus event, then the structure changes for the six added rows. No text-selection events fired.

Earlier captures on the app itself (DOM + UIA) agree: one click, one `aria-expanded` change and one UIA expansion event per Space press, with focus on the button arriving just before the click handler runs.

## What the direct-ExpandCollapse probe does and does not show

A separate read-only probe called UIA `ExpandCollapsePattern.Expand()` directly (the button exposes ExpandCollapse and ScrollItem but not Invoke) and compared Chrome with Edge. The two browsers exposed the same control type, name, patterns, state change, event stream and text ranges, apart from the reported font family (Arial in Chrome, Roboto in Edge) and a few milliseconds of event-order jitter.

That probe used a **different activation path** from the one Narrator actually uses (the mouse-style sequence above). It is evidence about the direct-Expand() path only and should not be read as a description of Narrator's Down Arrow → Space activation.

## Hypothesis (unproven)

Narrator receives a focus event and an `ExpandCollapse` change within a few milliseconds of each other, and the button is already expanded when the focus event arrives. That fits "one read for the focus, one for the state change". On the Tab path the focus arrives well before the state change, and a single announcement was tentatively reported there.

**Diagnostic experiment E1 (not a fix).** On the standalone page, when `focusin` preceded the `pointerdown` (Narrator's order), the whole state change was applied 300 ms later. The reported speech was a fragmented arrival, a "collapsed" read, then "expanded" once, which is what the hypothesis predicts. One count in that report did not match the page, so it is treated as **diagnostic evidence only** and needs a clean repeat. E1 would also add a spoken "collapsed" before "expanded", so it does not meet the intended acceptance check.

## Things already tried in the app that did not fix it

Using an invisible justified label versus one visible label (the visible label is what this repository now has); a native `<details>/<summary>`; moving the sharing links; a button-position and viewport comparison; removing the reveal scroll; focusing the button before the click handler; a deferral that only ran when the button was unfocused at click time (it never ran for Narrator, whose click arrives already focused); turning extensions off.

## Not established

- Whether the cause is Narrator's own handling, Chrome's UIA implementation, or an interaction of both.
- Why Edge read the original page correctly in one pass but not the instrumented copy.
- Whether the focus/state timing hypothesis is right.
- Firefox behavior (navigation to the button was blocked).
- No matching Chromium or Microsoft report was found for these versions. The closest related Chromium issue (Narrator speaking dictated text twice because two UIA notifications fired for one change) has a different trigger.

## Next step (evidence-based)

Re-run Edge on the **original** standalone page (no logger, no title suffix) to see whether its earlier correct result is stable. If it still reads correctly, the logged copy's title or script is implicated; if it now fails too, session or Narrator variability explains the change and the Edge/Chrome difference cannot be used. Then repeat E1 once on the instrumented page to confirm or reject the focus/state timing hypothesis.

## Related application state

The Achievements toggle is named by one visible label and the Achievement Unlocked card keeps its name and description exposed (see the pull request that introduced them). The duplicate "expanded" announcement is **not** fixed by that change.
