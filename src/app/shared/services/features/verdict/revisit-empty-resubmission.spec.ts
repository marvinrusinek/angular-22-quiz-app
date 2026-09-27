import { TestBed } from '@angular/core/testing';
import { Observable, Subject } from 'rxjs';

import { QuestionVerdictService } from './question-verdict.service';
import type { QuestionCheckResult } from './question-verdict.types';
import { TOPIC_QUIZ_VERDICT_ADAPTER } from './verdict-adapter';
import { blocksIntermediateProgression } from './progression-gate';

/**
 * REVISIT'S EMPTY-RESUBMISSION ARTIFACT vs an ALREADY-EARNED resolved-correct
 * PHASE — live-reproduced 2026-09-27.
 *
 * Revisiting an answered question re-submits (documented at length in
 * `applyResult`'s `incomplete` branch): the live option bindings on a revisit
 * do not yet carry the first-visit picks, so the app resubmits an EMPTY
 * selection before the remembered picks re-hydrate, and the backend answers
 * `incomplete` for ANY empty submission regardless of question type
 * (`answer-check.ts`). The existing code already protects `selectedVerdicts`
 * and `correctOptionTexts` from this ("a reveal, once earned, is not taken
 * back") — but until this fix, `phase` itself was NOT protected: it was
 * unconditionally overwritten to `checking` then `incomplete`, downgrading an
 * earned resolved-correct question back to a BLOCKING phase with no user
 * action at all. Once `phase` started gating Next/forward-navigation
 * (progression-gate.ts), that silently froze real revisit navigation:
 * `e2e/revisit-disable.spec.ts` and `e2e/shuffle.spec.ts`'s bounce test both
 * hung on exactly this (Next stuck disabled after Previous → Next back to an
 * already-correct question, live-reproduced via a console probe).
 */

const QUIZ = 'fixture-gadgets';
const Q1 = 'Which gadget mode uses the least power?';

const RESOLVED_CORRECT: QuestionCheckResult = {
  status: 'resolved', correct: true, correctOptionTexts: ['sleep'], explanation: 'e'
} as QuestionCheckResult;
const RESOLVED_INCORRECT: QuestionCheckResult = {
  status: 'resolved', correct: false, correctOptionTexts: ['sleep'], explanation: 'e'
} as QuestionCheckResult;
const EMPTY_INCOMPLETE: QuestionCheckResult = {
  status: 'incomplete', selectedVerdicts: [], remainingCorrectCount: 1
} as QuestionCheckResult;
const REAL_PARTIAL_INCOMPLETE: QuestionCheckResult = {
  status: 'incomplete', selectedVerdicts: [{ text: 'a', correct: true }], remainingCorrectCount: 1
} as QuestionCheckResult;

let verdicts: QuestionVerdictService;
let responses: Subject<QuestionCheckResult>[];

function mockAdapterCheck(): Observable<QuestionCheckResult> {
  const subject = new Subject<QuestionCheckResult>();
  responses.push(subject);
  return subject.asObservable();
}

beforeEach(() => {
  responses = [];
  TestBed.configureTestingModule({
    providers: [
      {
        provide: TOPIC_QUIZ_VERDICT_ADAPTER,
        useValue: { check: mockAdapterCheck, revealExpired: mockAdapterCheck }
      }
    ]
  });
  verdicts = TestBed.inject(QuestionVerdictService);
});

function submit(texts: string[]): void {
  verdicts.checkAnswer(QUIZ, Q1, texts).subscribe({ error: () => undefined });
}
function resolveLatest(result: QuestionCheckResult): void {
  responses[responses.length - 1]!.next(result);
}

describe('an empty resubmission on an already resolved-correct question', () => {
  it('does NOT downgrade the phase away from resolved-correct once the response lands (a brief `checking` flash while in flight is expected and harmless)', () => {
    submit(['sleep']);
    resolveLatest(RESOLVED_CORRECT);
    expect(verdicts.verdictFor(QUIZ, Q1).phase).toBe('resolved');

    // The revisit artifact: a NEW, EMPTY submission for the SAME question.
    // `markChecking` still flips the phase to `checking` for the round trip —
    // that part is unchanged and fine (it clears on its own in well under a
    // render frame); what must NOT happen is landing on `incomplete` after.
    submit([]);
    expect(verdicts.verdictFor(QUIZ, Q1).phase).toBe('checking');
    resolveLatest(EMPTY_INCOMPLETE);

    const state = verdicts.verdictFor(QUIZ, Q1);
    expect(state.phase).toBe('resolved');                          // NOT 'incomplete'
    expect(state.isResolvedCorrect).toBe(true);
    expect(blocksIntermediateProgression(state.phase, state.isResolvedCorrect)).toBe(false); // Next/forward-nav stays unblocked
  });

  it('still ends up incomplete for a genuinely UNRESOLVED question (no artifact protection applies)', () => {
    submit([]);
    resolveLatest(EMPTY_INCOMPLETE);
    const state = verdicts.verdictFor(QUIZ, Q1);
    expect(state.phase).toBe('incomplete');
    expect(blocksIntermediateProgression(state.phase, state.isResolvedCorrect)).toBe(true);
  });

  it('does not protect a resolved-INCORRECT question — an empty resubmission there still lands as incomplete', () => {
    // Resolved-incorrect ALREADY blocks intermediate progression (the two
    // phases agree either way), but this pins that the guard is specific to
    // isResolvedCorrect===true, not just phase==='resolved'.
    submit(['turbo']);
    resolveLatest(RESOLVED_INCORRECT);
    submit([]);
    resolveLatest(EMPTY_INCOMPLETE);
    const state = verdicts.verdictFor(QUIZ, Q1);
    expect(state.phase).toBe('incomplete');
    expect(blocksIntermediateProgression(state.phase, state.isResolvedCorrect)).toBe(true);
  });

  it('a REAL (non-empty) partial resubmission on an already resolved-correct question is NOT swallowed', () => {
    // Only an EMPTY submission is treated as the artifact; a genuine new
    // selection must still be processed normally (never silently dropped).
    submit(['sleep']);
    resolveLatest(RESOLVED_CORRECT);
    submit(['a']);
    resolveLatest(REAL_PARTIAL_INCOMPLETE);
    expect(verdicts.verdictFor(QUIZ, Q1).phase).toBe('incomplete');
  });

  it('preserves the correct reveal for later reads (correctOptionTexts/explanation intact)', () => {
    submit(['sleep']);
    resolveLatest(RESOLVED_CORRECT);
    submit([]);
    resolveLatest(EMPTY_INCOMPLETE);
    const state = verdicts.verdictFor(QUIZ, Q1);
    expect(state.correctOptionTexts).toEqual(['sleep']);
    expect(state.explanation).toBe('e');
  });
});
