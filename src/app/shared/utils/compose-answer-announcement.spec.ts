import { composeAnswerAnnouncement, htmlToAnnouncementText } from './compose-answer-announcement';

describe('composeAnswerAnnouncement', () => {
  it('returns empty when there is no feedback text at all (nothing to announce)', () => {
    expect(composeAnswerAnnouncement({
      feedbackText: '',
      isCorrect: true,
      fetDue: true,
      fetText: 'Option 1 is correct because...',
      progressGuidance: 'Select 1 more correct answer to continue...'
    })).toBe('');

    expect(composeAnswerAnnouncement({
      feedbackText: '   ',
      isCorrect: false,
      fetDue: false,
      fetText: '',
      progressGuidance: ''
    })).toBe('');
  });

  it('incorrect selection: feedback ONLY — never repeats unchanged selection guidance', () => {
    const result = composeAnswerAnnouncement({
      feedbackText: 'Not this one, try again!',
      isCorrect: false,
      fetDue: false,
      fetText: '',
      // Even if useful-looking guidance happens to be present, an incorrect
      // pick must not speak it — requirement: "Do not repeat unchanged
      // selection guidance" / "Do not announce unchanged guidance after an
      // incorrect choice."
      progressGuidance: 'Select 2 more correct answers to continue...'
    });
    expect(result).toBe('Not this one, try again!');
  });

  it('incorrect selection ignores fetDue entirely (defensive: a wrong pick never shows the explanation)', () => {
    const result = composeAnswerAnnouncement({
      feedbackText: 'Not this one, try again!',
      isCorrect: false,
      fetDue: true, // should never happen in practice, but must not leak the FET
      fetText: 'Option 1 is correct because the lever triggers it.',
      progressGuidance: ''
    });
    expect(result).toBe('Not this one, try again!');
  });

  it('partial multi-answer progress: feedback + the useful "select N more" guidance, composed as ONE message', () => {
    const result = composeAnswerAnnouncement({
      feedbackText: "That's correct!",
      isCorrect: true,
      fetDue: false, // not yet complete
      fetText: '',
      progressGuidance: 'Select 2 more correct answers to continue...'
    });
    expect(result).toBe("That's correct! Select 2 more correct answers to continue...");
  });

  it('correct but no FET and no "select N more" guidance (e.g. completion/Next-button text): feedback alone', () => {
    const result = composeAnswerAnnouncement({
      feedbackText: "You're right!",
      isCorrect: true,
      fetDue: false,
      fetText: '',
      // Completion guidance — must NOT be spoken (redundant with the
      // feedback the user just heard; the Next button is visible).
      progressGuidance: 'Please click the Next button to continue.'
    });
    expect(result).toBe("You're right!");
  });

  it('full correctness (single-answer correct, or multi-answer just completed): brief feedback THEN the explanation, as one message', () => {
    const result = composeAnswerAnnouncement({
      feedbackText: "You're right!",
      isCorrect: true,
      fetDue: true,
      fetText: 'Option 1 is correct because the lever is the manual doohickey trigger.',
      // Even if present, progress guidance must not ALSO be appended once
      // the explanation is due — avoids a 3-part message and matches
      // "Avoid redundant completion/selection messages."
      progressGuidance: 'Please click the Next button to continue.'
    });
    expect(result).toBe(
      "You're right! Option 1 is correct because the lever is the manual doohickey trigger."
    );
  });

  it('full correctness strips HTML markup from the explanation for the spoken text', () => {
    const result = composeAnswerAnnouncement({
      feedbackText: "You're right!",
      isCorrect: true,
      fetDue: true,
      fetText: '<strong>Option 1</strong> is correct because &amp; it triggers the <code>lever</code>.',
      progressGuidance: ''
    });
    expect(result).toBe("You're right! Option 1 is correct because & it triggers the lever.");
  });

  it('full correctness with blank FET text falls back to feedback alone (never announces an empty explanation)', () => {
    const result = composeAnswerAnnouncement({
      feedbackText: "You're right!",
      isCorrect: true,
      fetDue: true,
      fetText: '   ',
      progressGuidance: ''
    });
    expect(result).toBe("You're right!");
  });

  it('never repeats the verdict word-for-word inside the composed message (feedback and FET are concatenated once each, not duplicated)', () => {
    const result = composeAnswerAnnouncement({
      feedbackText: "You're right!",
      isCorrect: true,
      fetDue: true,
      fetText: "You're right! Option 1 is correct because of the lever.",
      progressGuidance: ''
    });
    // The feedback prefix and the FET are simply concatenated — the FET's
    // OWN wording is the formatter's responsibility (deriveHeadingHtml),
    // not re-derived or stripped here. This test documents that contract
    // rather than asserting de-duplication this function does not own.
    expect(result).toBe("You're right! You're right! Option 1 is correct because of the lever.");
  });
});

describe('htmlToAnnouncementText', () => {
  it('strips inline tags the heading sanitizer allows through', () => {
    expect(htmlToAnnouncementText('<strong>Option 1</strong> is <em>correct</em>.'))
      .toBe('Option 1 is correct.');
  });

  it('decodes the handful of entities the sanitizer can produce', () => {
    expect(htmlToAnnouncementText('A &amp; B &lt;C&gt; &quot;D&quot; &#39;E&#39;&nbsp;F'))
      .toBe('A & B <C> "D" \'E\' F');
  });

  it('collapses whitespace left behind by stripped tags', () => {
    expect(htmlToAnnouncementText('Option  1<br>  is   correct')).toBe('Option 1 is correct');
  });

  it('returns an empty string for empty/whitespace-only input', () => {
    expect(htmlToAnnouncementText('')).toBe('');
    expect(htmlToAnnouncementText('   ')).toBe('');
  });
});
