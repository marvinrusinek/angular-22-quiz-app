# Achievements toggle — Narrator announces "expanded" twice, and splits the collapsed name

**Status: OPEN, unresolved. Cause undetermined. No acceptable workaround found so far.** Investigation note, updated 2026-11-06. No application behavior is changed by this note.

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

Windows 11 25H2 (build 26200.9711), Narrator.exe 10.0.26100.8972, Chrome 156.0.8078.80, Edge 156.0.4314.58, display scaling 250%, browser zoom 100%. "Sync the Narrator cursor and system focus" is **on**. Firefox 159.0.1 was installed but Down Arrow navigation to the button was blocked, so Firefox is untested.

## What the actual-Narrator captures establish

Page-side (DOM) and UIA-side logs were recorded together with a shared epoch-millisecond clock, using a passive logger on the page and a read-only UIA client scoped to the browser window.

1. **Space reaches the page as mouse events, not as a key.** Focus lands on the button; 6–16 ms later come `pointerdown` (pointer type mouse), `mousedown`, `pointerup`, `mouseup` and `click` (detail 1); `aria-expanded` changes from false to true about 1 ms after the click. There is no `keydown` or `keyup` for Space. One click and one state change per press.
2. **UIA timing in the failing runs.** The UIA focus event reached the client 33–54 ms after the DOM focus, after the click and the `aria-expanded` write; the `ExpandCollapseState` change followed 2–8 ms later; then the structure changes for the six added rows. No text-selection events.
3. **Arrival focus separates the outcomes.** In every logged run, a single "expanded" announcement coincided with the button already having focus before Space; the split name and doubled expansion coincided with nothing being focused on arrival (focus came only with the activation):

| Run (Chrome 156 unless noted) | Button focused before Space | Outcome |
| --- | --- | --- |
| Edge, original standalone page | yes | name read correctly; "expanded" once |
| Edge, original page plus the passive logger | yes | name read correctly; "expanded" once |
| Chrome, original page plus the passive logger | yes | name read correctly; "expanded" once |
| App page in Incognito (first pass) | yes (Down Arrow scrolled to and focused it) | once |
| Chrome and Edge, logged copy with a " (logged)" title suffix | no | split name; "expanded" twice |
| Chrome, three sharing links before the button | no | split name; "expanded" twice |
| Chrome, E-mail and Share links before the button | no (the E-mail link was focused) | split name; "expanded" twice |
| Chrome, sharing links after the button in DOM order (shown above it with CSS) | no | split name; "expanded" twice |
| Regular app page | no | split name; "expanded" twice |

What the table does **not** show: why Narrator focuses the button on arrival in some passes and not in others. Page content does not predict it (pages without links both passed and failed; pages with links before or after the button all failed; the same Chrome and Narrator session flipped between pages), so the earlier idea that preceding sharing links explain the failure is **incomplete**. Pass-to-pass variability remains a confound.

## Diagnostic experiment E1 (not a fix)

On the standalone page, when `focusin` preceded the `pointerdown` by 40 ms or less (Narrator's order), the whole state change was applied 300 ms later; mouse and keyboard activation stayed immediate. The page logged which branch ran.

- Both logged activations took the **deferred** branch (`focusin` to `pointerdown` 5 and 6 ms; state change applied 301 and 313 ms after the click).
- UIA: the button's focus event arrived about 26 ms after the DOM focus with the button still **collapsed**; the expansion change arrived about 307 ms after that. In the immediate flow those two events are 2–8 ms apart.
- Speech: arrival **still split**; after one Space, "Achievements 6 of 6 button collapsed", then "Achievements 6 of 6 button expanded" **once**.

This supports the focus/state timing hypothesis (below) but does not prove which event produced which spoken line. It **fails the acceptance criteria**: it adds an arbitrary 300 ms delay and an extra spoken "collapsed", and arrival is unaffected. It is recorded as diagnostic evidence only.

## Chromium source findings (tag 156.0.8078.80, commit `fb096c0011f9d50f0a264a9376420cdea9c421e3`, public GitHub mirror)

Code findings, read directly from the source at that revision:

- **No Invoke on a stateful button.** `ui/accessibility/ax_node_data.cc` `AXNodeData::IsInvocable()` (~813–822): a control that "maintains state" (expand-collapse or toggle) is clickable but not invocable. `ui/accessibility/platform/ax_platform_node_win.cc` therefore exposes `IExpandCollapseProvider` for a button with `aria-expanded` and no `IInvokeProvider` (consistent with the UIA patterns measured: ExpandCollapse and ScrollItem).
- **`Expand()` and DoDefault converge.** `AXPlatformNodeWin::Expand()` (~2761) performs `Action::kExpand`; `Invoke()` (~2959) and `accDoDefaultAction` (~1661) perform `Action::kDoDefault`. In `third_party/blink/renderer/modules/accessibility/ax_object.cc`, `RequestExpandAction()` (~8053) returns `RequestClickAction()` for roles that do not use arrow keys for expand/collapse (only tree items do, per `SupportsArrowKeysForExpandCollapse`, `ui/accessibility/ax_role_properties.cc` ~1200), so for a button both reach the same `OnNativeClickAction()` (~7934). The earlier direct-`Expand()` probe therefore differs from Narrator's real call at the UIA API layer, but not in the renderer action it reaches. Which UIA call Narrator makes is not observable from these logs.
- **The renderer focuses first, then clicks.** `OnNativeClickAction()` explicitly focuses a focusable, not-yet-focused element (`SetFocusedElement(..., FocusType::kMouse)`, ~7956 "to be consistent with `EventHandler::HandleMousePressEvent`") and then sends a simulated click (`AccessKeyAction(SimulatedClickCreationScope::kFromAccessibility)`). This matches the captured `focusin` then `pointerdown`/`mousedown`/`mouseup`/`click` sequence.
- **Focus event is fired before other events on the same node, by design.** `ui/accessibility/platform/browser_accessibility_manager.cc` `OnAccessibilityEvents` (~650): generated events on the focused node are deferred until `FireFocusEventsIfNeeded()` has run, with the comment "Screen readers might not process events related to the currently-focused node if they are not aware that node is now focused, so fire a focus event before firing any other events on that node." On Windows, `BrowserAccessibilityManagerWin::FireFocusEvent` raises `UIA_AutomationFocusChangedEventId` and `AXEventGenerator::Event::EXPANDED`/`COLLAPSED` raises a `UIA_ExpandCollapseExpandCollapseStatePropertyId` property-changed event (`browser_accessibility_manager_win.cc` ~279, ~431). This explains the observed order (UIA focus, then the expansion change, a few ms apart) when focus and the state change land in the same update.

Hypotheses, **not** established by the source:

- Narrator announces the focus event (reading the element's then-current state, "expanded") and then announces the state-change event, giving two "expanded" reads; with the state change 0.3 s later (E1) the first read says "collapsed". Which UIA event Narrator speaks from for each line is not known.
- The split collapsed name on arrival correlates with the button not having been focused on arrival; the cause of the split is not identified.

Supported page behavior that could change the ordering: only the **timing of the state change relative to the accessibility update** that carries the focus (E1's delay), because the source focuses a focusable target before clicking and defers state events until after the focus event. The only other lever, making the control not focusable, is not acceptable for a keyboard-operable control.

## Things already tried in the app that did not fix it

Invisible justified label versus one visible label (the visible label is what this repository now has); native `<details>/<summary>`; moving or removing the sharing links; a button-position and viewport comparison; removing the reveal scroll; focusing the button before the click handler; a deferral that only ran when the button was unfocused at click time (it never ran for Narrator, whose click arrives already focused); turning extensions off; `aria-controls` removal.

## Not established

- Whether the cause is Narrator's own handling, Chrome's UIA implementation, or an interaction of both.
- Why Narrator focuses the button on arrival in some passes and not in others, even with "Sync the Narrator cursor and system focus" on.
- Whether the focus/state timing hypothesis is right.
- Firefox behavior (navigation to the button was blocked).
- No matching Chromium or Microsoft report was found. The closest related Chromium issue (Narrator speaking dictated text twice because two UIA notifications fired for one change) has a different trigger.

## Conclusion

**No acceptable workaround found so far.** Every page-side change tested either did not alter the behavior or (E1) altered it only by adding a delay and an extra "collapsed" announcement. The visible label and the readable unlock card in the application are kept; the duplicate "expanded" announcement and the split name on arrival are **not** fixed by them.

## Next step

A single upstream report with the standalone repro and the captures (Chromium and Microsoft's Narrator feedback channel), asking whether a client should de-duplicate a focus event and an `ExpandCollapse` change that arrive a few milliseconds apart for the same element, or whether Chromium should avoid raising the expansion change when the focus event already carries the new state. Filing is pending the maintainer's approval.
