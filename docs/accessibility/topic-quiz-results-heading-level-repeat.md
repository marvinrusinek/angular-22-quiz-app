# Topic Quiz Results — "Score Analysis" heading-level repeat

**Status: OPEN, unresolved. Cause undetermined.** The word split in the
heading is resolved locally (see "What changed"); the repeated
heading-level speech is not.

This is a record of what was observed, not a diagnosis. Nothing here
establishes a Chrome bug, a Narrator bug, or a defect in the page's markup.

## Symptom

Windows Narrator, scan mode, Chrome, Topic Quiz Results page. Approaching
the `<h3 class="section-heading">Score Analysis</h3>` heading with Down Arrow:

| State | Narrator says |
| --- | --- |
| Deployed page (`75d9e62b`) and localhost, before this work | "heading level 3 **Score** heading level 3 **Analysis**" (words split) |
| Localhost after this work | "heading level 3 Score Analysis heading level 3" (words together, level announced before **and** after) |

Other ways of reaching the same heading read it once and together: the `H`
key ("Score Analysis, heading level 3"), and Up Arrow back onto it.

Note: an earlier session recorded this heading as reading together under Down Arrow on the deployed site (2026-10-21, after the entry-focus delay fix). In this session the deployed page (same source commit) split. The two results are not reconciled here.

## What changed in the app (local, uncommitted)

- The Results header logo is no longer wrapped in an external
  `https://www.codelab.fun` link. It is a native `<button>` named
  "Back to quiz selection" (`[attr.aria-label]` bound to a `$localize`
  field) containing a decorative image (`alt=""`), with the click handler
  moved onto the button and a visible `:focus-visible` ring. This removed
  the word split.
- Statistics groups (separate work, all manually confirmed): score
  sentence, elapsed-time sentence, ring, breakdown, stars, trophy/badge and
  timer each read as one named graphic or one text node.

## Evidence

Standalone reproductions (served locally from a scratch directory, not part
of the app). Pass/fail refers to Down Arrow into the heading.

| Page | Result |
| --- | --- |
| Hand-written minimal structure of the Results page | passes: "Score Analysis, heading level 3" |
| Full capture of the live deployed page, exact CSS inlined | fails: word split |
| Same capture with all author CSS removed | fails: word split |
| …live regions removed / logo `aria-describedby` and tooltip container removed / `mat-card` unwrapped / everything after the heading removed (four variants) | all fail |
| …header reduced to the Results `h1` only | words together; level repeated |
| …+ logo link and image restored | words split |
| …+ menu button restored | words together |
| …logo image restored but the `<a>` unwrapped | words together; level repeated |
| …logo link kept, given an `aria-label`, image `alt=""` | fails: lost the initial "S" |
| Matched pair: current-app header (button logo), original h3 vs plain `<h3>` | both: "heading level 3 Score Analysis heading level 3" |

Also tried inside the Angular app, none of which fixed the split: disabling
Results animations, replacing the heading's gradient text with solid text,
resetting the heading's styles with `all: revert`, an explicit `aria-label`
on the h3, a non-breaking space between the words, and removing the
negative-margin overlap with the header. An earlier session also ruled out
several other theories.

Windows UI Automation (read-only, COM `IUIAutomation`) on the live page
showed the heading with a uniform Heading 3 style across its whole text
range, correct word/line boundaries, and the heading-level property set to
3. Its neighbors in the text stream were embedded-object characters (the
logo link and the following image groups) where the comparison heading
"Challenge your friends!" had ordinary text. This was an observation, not
an established cause.

## What is and isn't known

- The heading's own markup, text node, name and style attributes are clean.
- The repeated level reproduces on a plain, unstyled heading in a
  standalone page, so it does not depend on the original heading's
  class/attributes or the app's CSS.
- A link wrapping the logo image before the heading correlates with the
  word split; removing the link removed it.
- Not established: why the level is announced before and after the words,
  or whether a page can avoid it at all.

## Next steps (not done)

- Retest the repeated level on other Narrator versions and in Edge.
- Check whether other headings reached by Down Arrow show the same pattern
  (the Interview Readiness heading is documented with a similar
  unresolved behavior).
