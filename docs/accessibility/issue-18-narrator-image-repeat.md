# Issue #18 — Narrator image announcement investigation

**Status: OPEN, unresolved. Cause undetermined.**

## Symptom

With Windows Narrator in scan mode, pressing Down Arrow to reach the
topic image on the Introduction page:

- After in-app navigation (Quiz Selection → the Dependency Injection
  tile → Introduction, a client-side route change): the image's
  accessible name has been announced **4 times** on a single arrival at
  that element in the large majority of recorded trials. One recorded
  trial via this same path (an in-app click immediately followed by a
  scan-mode Down Arrow) instead produced a single announcement, so this
  is not exceptionless.
- After a direct/fresh navigation straight to the same Introduction URL
  (no client-side route change involved): the image has been announced
  **once** in every trial recorded so far; no exception to this one has
  been observed.

The 4x-on-in-app pattern is the most consistently observed result in
the whole investigation, but given the one known exception above, and
given that it has not itself been run through a formal counterbalanced
protocol the way candidate code-level causes were (see Limitations),
treat it as a strong, repeated correlation — not an exceptionless or
confirmed causal mechanism tied to navigation type.

## Reproduction

1. Run the app, go to Quiz Selection.
2. Turn on Narrator scan mode.
3. Click the Dependency Injection tile to land on its Introduction page
   via normal in-app navigation. (This is the only tile tested in this
   investigation — the symptom has not been checked against any other
   quiz's tile, so it should not be assumed to generalize to "any"
   tile.)
4. Press Down Arrow until the scan cursor reaches the topic image.
5. Count how many times its name is announced on that single arrival.

Repeating step 1-4 via a fresh browser tab navigated directly to the
same Introduction URL (skipping Quiz Selection) has instead produced one
announcement in every trial recorded so far, with no exception observed
— see Confirmed findings and Limitations for the one known exception on
the in-app side.

A minimal, framework-free HTML reproduction (two static files plus the
real image asset, no Angular/router/build tooling) was also built to
isolate candidate causes outside the app. It is kept outside this repo;
ask if you need it for further investigation.

## Confirmed findings

- The in-app vs. direct-navigation contrast above has been observed in
  the large majority of trials run so far, across many separate
  sessions, with one recorded in-app exception (see Symptom) — and like
  every other candidate contrast tested in this investigation, it has
  not been run through a formal counterbalanced protocol, so it is
  reported as a strong correlation, not a confirmed cause.

**Excluded as causes** (confirmed via direct, instrumented evidence on
the real app, not just repeated-trial correlation):
- Image format (PNG vs. WebP) does not explain the in-app/direct
  contrast: switching the real app's image to PNG still produced 4x
  announcements on in-app navigation, so format is excluded as the
  explanation for the symptom.
- A duplicate `introImgSig` write during quiz load is excluded as a
  mechanism: a live DOM mutation trace on the real app recorded the
  image `src` being written exactly once, with zero attribute
  mutations, and a direct comparison of the bundled metadata against
  the live API response showed both of the component's two write calls
  produce the byte-identical value — so no real second mutation ever
  occurs for this quiz.

**Tested, unsuccessful candidates** (not confirmed exclusions — each
was only tested in the minimal reproduction or in a small number of
real-app trials, and the reproduction was later shown, via a
counterbalanced retest, to vary between trials independent of code
changes; these should not be read as ruled out with the same confidence
as the two exclusions above):
- A CSS `display: flex` → `display: block` change on the image was
  applied directly to the real app and manually retested once — the
  real app's result did not change (still announced repeatedly). It was
  reverted. This is a single real-app retest, not a repeated or
  counterbalanced one.
- Image node creation-vs-reuse timing during navigation was tested only
  in the minimal reproduction (both variants read 4x there) — not
  retested with counterbalancing, so it carries the same noise caveat as
  the `pushState`/title-change candidate described in Limitations below.
- Live Windows UI Automation event capture (`FocusChanged`,
  `PropertyChanged` on Name/BoundingRectangle, `StructureChanged`)
  during instrumented trials of the minimal reproduction recorded
  **zero** events of any kind targeting the image element, despite the
  repeated announcement being heard in the same trials. This event set
  does not appear to capture whatever mechanism produces the repeated
  speech.
- Eight automated, headless (no assistive technology attached) Chrome
  DevTools Protocol trials of an unchanged minimal reproduction file
  produced identical accessibility-event counts every time — this rules
  out non-determinism in those specific two CDP event types under
  headless conditions only; it does not rule out Windows UIA-level
  behavior or timing effects that only occur with Narrator actually
  attached.
- Primary-source research (Chromium source/commits, a W3C ARIA tracking
  issue, Microsoft's UI Automation documentation) found no evidence that
  either of two deeper UIA signals — the `NotificationEvent` type, or
  Narrator's internal scan-cursor position being reflected in the
  browser's `TextPattern` selection — applies to ordinary (non-live-
  region) content reading. Neither is a documented, relevant mechanism
  for this symptom.

## Limitations — what is NOT established

- **No specific code property has been confirmed as the cause.** Two
  candidates (the CSS `display` value, and a combination of
  `history.pushState()` + a `document.title` change mirroring the app's
  own router/title-service behavior) each showed a correlation across
  only one or two early trials of the minimal reproduction. A later
  counterbalanced retest (alternating trials of the same unchanged files
  in a fixed order) showed the **same unchanged file reading differently
  across consecutive trials** with no code change at all. Counting every
  recorded trial of each exact file: the baseline file read 1, 4, 4, 4
  (3 of 4 trials repeated); the combined pushState+title file read 4, 4,
  1, 4, 4, 4 (5 of 6 trials repeated). Both predominantly read as
  repeated announcements across their full trial histories — the
  earlier single-trial contrast does not hold up and is not treated as
  a cause.
- It is not established whether the repeated announcement originates in
  Chromium's own accessibility-tree generation, the Windows UIA
  event-delivery layer, Narrator's own internal processing, or a timing
  interaction that only occurs while Narrator is actively attached
  (automated, AT-less testing cannot exercise that case).
- No standards-compliant, evidence-backed application-level mitigation
  has been identified as of this writing. Every app-side candidate
  tested either had no effect on the real app or was invalidated by the
  counterbalanced retest described above.

## Next steps

None currently proposed. Re-opening investigation would need either a
new, specific hypothesis backed by evidence, or confirmation from
Chromium/Microsoft accessibility teams on the underlying mechanism. No
workaround (forced reload, live-region announcement, artificial delay)
has been applied, since none would address a confirmed cause and all
would risk masking rather than fixing the behavior.
