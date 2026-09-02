import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { ExplanationFormatterService } from '../services/features/explanation/explanation-formatter.service';
import { buildHeadingInputs } from './heading-inputs';
import { deriveHeadingHtml } from './heading-model';

/**
 * AN AUTHORIZED REVEAL OUTRANKS A LOCAL PLACEHOLDER.
 *
 * ── The live defect this pins ─────────────────────────────────────
 *
 * A timed-out question on GitHub Pages read:
 *
 *     Time's up. No explanation available.
 *
 * while the same flow locally read:
 *
 *     Time's up. Correct answer: The Router  Option 1 is correct because …
 *
 * ── Why latency decided it ────────────────────────────────────────
 *
 * `initializeFormattedExplanations` stored `'No explanation available'` for any
 * question with no explanation of its own — which, since S4, is EVERY
 * API-sourced question: the explanation names the correct options, so only
 * `/check` may release it.
 *
 * That string is truthy and sits at the head of the chain `heading-inputs`
 * consults:
 *
 *     formattedExplanations[idx] || fetByIndex || timeoutFetByIndex || authorized
 *
 * so it shadowed the authorized reveal arriving a round trip later. Locally the
 * backend answered fast enough that something overwrote it; against a deployed
 * backend nothing did, and the placeholder stayed on screen permanently.
 *
 * The ordering is what these pin — not the literal string. A test that only
 * asserted "the heading is non-empty" passed throughout the defect.
 */

const IDX = 3;
const QUESTION = 'Which Angular feature maps URLs to views?';
const AUTHORIZED = 'Option 1 is correct because the Router maps each URL to a component.';

/** Heading dependencies, with the two timing-sensitive stores injectable. */
function deps(over: {
  formattedExplanations?: Record<number, { questionIndex: number; explanation: string }>;
  verdictPhase?: string;
  verdictExplanation?: string;
  correctOptionTexts?: string[];
}) {
  const question = { questionText: QUESTION, options: [{}, {}, {}, {}] };
  return {
    idx: IDX,
    quizService: {
      quizId: 'router',
      getQuestionsInDisplayOrder: () =>
        Object.assign([], { [IDX]: question, length: IDX + 1 }),
      questions: Object.assign([], { [IDX]: question, length: IDX + 1 }),
      isShuffleEnabled: () => false,
      shuffledQuestions: [],
      isMultiAnswerComplete: () => false
    },
    explanationTextService: {
      formattedExplanations: over.formattedExplanations ?? {},
      fetByIndex: new Map<number, string>(),
      timeoutFetByIndex: new Map<number, string>(),
      fetBypassForQuestion: new Map<number, boolean>()
    },
    // A LIVE timeout: expired for this question, not merely on arrival.
    timerService: {
      expiredForQuestionIndexSig: () => IDX,
      expiredOnArrivalSig: () => -1
    },
    selectedOptionService: { selectedOptionsMap: new Map() },
    quizStateService: {
      hasUserInteracted: () => false,
      wasInteractedThisVisit: () => false
    },
    quizNavigationService: { isNavigatingToPreviousSig: () => false },
    quizQuestionManagerService: { getNumberOfCorrectAnswersText: () => '' },
    feedbackPolicyService: { feedbackMode: () => 'immediate' },
    questionVerdictService: {
      verdictFor: () => ({
        phase: over.verdictPhase ?? 'idle',
        selectedOptionTexts: [],
        selectedVerdicts: new Map<string, boolean>(),
        remainingCorrectCount: null,
        correctOptionTexts: over.correctOptionTexts ?? [],
        explanation: over.verdictExplanation ?? null,
        isResolvedCorrect: null
      }),
      states: () => new Map()
    }
  } as any;
}

const headingFor = (over: Parameters<typeof deps>[0]): string => {
  const inputs = buildHeadingInputs(deps(over));
  return deriveHeadingHtml({ ...inputs!, optionsReady: true });
};

describe('the formatter does not store absence as content', () => {
  let formatter: ExplanationFormatterService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) }
        },
        ExplanationFormatterService
      ]
    });
    formatter = TestBed.inject(ExplanationFormatterService);
  });

  it('stores NOTHING for a question with no explanation of its own', () => {
    // The shape every API-sourced question arrives in.
    formatter.initializeFormattedExplanations([
      { questionIndex: IDX, explanation: '' }
    ]);

    expect(formatter.formattedExplanations[IDX]).toBeUndefined();
  });

  it('stores nothing for whitespace-only explanation text either', () => {
    formatter.initializeFormattedExplanations([
      { questionIndex: IDX, explanation: '   ' }
    ]);

    expect(formatter.formattedExplanations[IDX]).toBeUndefined();
  });

  it('still stores a real explanation when the question genuinely has one', () => {
    formatter.initializeFormattedExplanations([
      { questionIndex: IDX, explanation: '  A real explanation.  ' }
    ]);

    expect(formatter.formattedExplanations[IDX]?.explanation).toBe('A real explanation.');
  });

  it('never writes the placeholder as if it were explanation content', () => {
    formatter.initializeFormattedExplanations([
      { questionIndex: 0, explanation: '' },
      { questionIndex: 1, explanation: '' }
    ]);

    const stored = Object.values(formatter.formattedExplanations)
      .map((e: any) => e?.explanation ?? '');
    expect(stored.join(' ')).not.toContain('No explanation available');
  });
});

describe('a timed-out question renders the AUTHORIZED explanation through the ordinary FET path — no expiry-specific wrapper', () => {
  it('shows the question, not any notice, before the reveal arrives', () => {
    // Nothing stored, nothing authorized: the honest state for "not yet".
    const html = headingFor({ verdictPhase: 'idle' });

    expect(html).not.toContain('No explanation available');
    expect(html).not.toContain('Correct answer');
    expect(html).not.toContain('Time&#39;s up');
  });

  it('shows the authorized explanation ALONE once the reveal lands — identical to a normal FET', () => {
    const html = headingFor({
      verdictPhase: 'expired',
      verdictExplanation: AUTHORIZED,
      correctOptionTexts: ['The Router']
    });

    expect(html).toBe(AUTHORIZED);
    expect(html).not.toContain('Time&#39;s up');
    expect(html).not.toContain('Correct answer');
    expect(html).not.toContain('No explanation available');
  });

  it('THE REGRESSION: a stored placeholder must not shadow the authorized reveal', () => {
    // Exactly the live ordering — the placeholder was written first, the reveal
    // arrived afterwards. With the placeholder no longer stored, the chain falls
    // through to the authorized text.
    const html = headingFor({
      formattedExplanations: {},   // fix A: absence is not stored
      verdictPhase: 'expired',
      verdictExplanation: AUTHORIZED,
      correctOptionTexts: ['The Router']
    });

    expect(html).toContain(AUTHORIZED);
    expect(html).not.toContain('No explanation available');
  });

  it('a REAL stored explanation still wins, so normal FET behaviour is unchanged', () => {
    // The head of the chain is still the head — this fix removes fabricated
    // entries, not legitimate ones.
    const real = 'A genuinely formatted explanation.';
    const html = headingFor({
      formattedExplanations: { [IDX]: { questionIndex: IDX, explanation: real } },
      verdictPhase: 'expired',
      verdictExplanation: AUTHORIZED,
      correctOptionTexts: ['The Router']
    });

    expect(html).toContain(real);
  });

  it('NEGATIVE CASE: reveal arrives carrying no explanation at all falls back to the question', () => {
    // The contract completed and there is genuinely nothing to say. With no
    // expiry-specific wrapper to hold a bare notice, this is the same "FET due
    // but no text yet" case as any other reveal — the question shows, nothing
    // is fabricated to fill the gap.
    const html = headingFor({
      verdictPhase: 'expired',
      verdictExplanation: '',
      correctOptionTexts: ['The Router']
    });

    expect(html).toBe(QUESTION);
    expect(html).not.toContain('undefined');
    expect(html).not.toContain('null');
  });
});
