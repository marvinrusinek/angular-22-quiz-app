import { isSameFeedbackEmission } from './feedback.component';

describe('isSameFeedbackEmission', () => {
  it('is false for an instance\'s first-ever emission (prev is null), regardless of content', () => {
    expect(isSameFeedbackEmission(null, { text: 'Not this one, try again!', isCorrect: false })).toBe(false);
    expect(isSameFeedbackEmission(null, { text: '', isCorrect: false })).toBe(false);
  });

  it('is true when text AND isCorrect both match the previous emission', () => {
    const prev = { text: 'Not this one, try again!', isCorrect: false };
    const next = { text: 'Not this one, try again!', isCorrect: false };
    expect(isSameFeedbackEmission(prev, next)).toBe(true);
  });

  it('is false when the text differs, even if isCorrect matches', () => {
    const prev = { text: 'Not this one, try again!', isCorrect: false };
    const next = { text: "You're right!", isCorrect: false };
    expect(isSameFeedbackEmission(prev, next)).toBe(false);
  });

  it('is false when isCorrect differs, even if the text happens to match', () => {
    // Defensive: should not happen in practice (correct/incorrect text
    // differs), but the guard must not key on text alone.
    const prev = { text: 'same wording', isCorrect: true };
    const next = { text: 'same wording', isCorrect: false };
    expect(isSameFeedbackEmission(prev, next)).toBe(false);
  });

  it('models the real-world regression: a NEW instance (fresh click) always emits at least once, even with text identical to a PRIOR, DIFFERENT instance\'s last emission', () => {
    // Instance A (first wrong pick) settles on this text.
    let lastEmittedA: { text: string; isCorrect: boolean } | null = null;
    const emissionA = { text: 'Not this one, try again!', isCorrect: false };
    expect(isSameFeedbackEmission(lastEmittedA, emissionA)).toBe(false); // emits
    lastEmittedA = emissionA;

    // Instance A's own effect re-runs with the SAME settled value (the bug
    // this fix targets) — must NOT re-emit.
    expect(isSameFeedbackEmission(lastEmittedA, emissionA)).toBe(true); // suppressed

    // Instance B is a BRAND NEW FeedbackComponent (a second, different
    // wrong pick) — its own `lastEmitted` starts at null regardless of
    // what instance A last emitted, so it always emits at least once even
    // though the wording is byte-identical.
    const lastEmittedB: { text: string; isCorrect: boolean } | null = null;
    const emissionB = { text: 'Not this one, try again!', isCorrect: false };
    expect(isSameFeedbackEmission(lastEmittedB, emissionB)).toBe(false); // emits
  });
});
