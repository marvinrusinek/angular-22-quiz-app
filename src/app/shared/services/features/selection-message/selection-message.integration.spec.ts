/**
 * SelectionMessageService integration tests.
 *
 * Guards the click → push → derived-signal pipeline that broke multiple
 * times during refactoring. The mock uses a REAL Angular signal for
 * currentQuestionIndexSig so the computed selectionMessageSig actually
 * re-evaluates when "nav" happens.
 *
 * Scenarios covered:
 *  - Click pushes override; derived signal reflects it
 *  - Nav transition invalidates a stale override
 *  - Revisiting an answered question derives "Answered ✓..." text
 *  - Last-question variant ("...Show Results...")
 *  - isCompletedInSession() public API (used by Show Results button gate)
 *  - resetAll() restores derived default
 *  - External maps (questionCorrectness etc.) don't influence the in-session
 *    answered probe
 */
import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { QuizDotStatusService } from '../../../services/flow/quiz-dot-status.service';
import { QuizService } from '../../../services/data/quiz.service';
import { SelectedOptionService } from '../../../services/state/selectedoption.service';
import { SelectionMessageService } from './selection-message.service';
import { QuestionVerdictService } from '../verdict/question-verdict.service';
import { IDLE_VERDICT_STATE, type QuestionVerdictState } from '../verdict/question-verdict.types';
import { QuestionType } from '../../../models/question-type.enum';

describe('SelectionMessageService integration', () => {
  let service: SelectionMessageService;
  let quizServiceMock: any;
  let currentIdxSig: WritableSignal<number>;

  const CONTINUE_MSG = 'Please select an option to continue...';
  const NEXT_BTN_MSG = 'Please click the Next button to continue.';
  const SHOW_RESULTS_MSG = 'Please click the Show Results button.';
  const ANSWERED_NEXT = 'Answered ✓ Click Next to continue...';
  const ANSWERED_SHOW = 'Answered ✓ Click Show Results...';

  /**
   * COMPLETION IS DRIVEN THROUGH THE VERDICT, NOT THROUGH MESSAGES.
   *
   * These tests used to mark a question complete by pushing NEXT_BTN_MSG,
   * because that is literally how the service recorded it. That coupling is
   * the defect this refactor removes: a display string decided a fact about
   * the answer, so auto-reveal, timer expiry and a message computed
   * before the verdict landed all registered as success.
   *
   * The behavioural intent of every test below is unchanged — per-index
   * isolation, no leakage across navigation, external maps never promoting
   * themselves into completion. Only the way completion is ESTABLISHED moved.
   */
  let verdictByText: Map<string, QuestionVerdictState>;
  /**
   * The real QuestionVerdictService keeps its states in a SIGNAL, so a
   * computed reading verdictFor() re-runs when a verdict lands. A plain Map
   * would leave the computed memoized and the harness would not reflect
   * production. This tick makes the stub track the same way.
   */
  let verdictTick: WritableSignal<number>;

  const qText = (idx: number) => `Q${idx} text`;

  /** Verdict fixtures, named for the user-visible situation they represent. */
  const setVerdict = (idx: number, state: Partial<QuestionVerdictState>) => {
    verdictByText.set(qText(idx), { ...IDLE_VERDICT_STATE, ...state } as QuestionVerdictState);
    verdictTick.update((n) => n + 1);
  };

  const clearVerdicts = () => {
    verdictByText.clear();
    verdictTick.update((n) => n + 1);
  };

  const singleCorrect = (idx: number) => setVerdict(idx, { phase: 'resolved', isResolvedCorrect: true });
  const singleWrong = (idx: number) => setVerdict(idx, { phase: 'resolved', isResolvedCorrect: false });
  const multiPartial = (idx: number) => setVerdict(idx, { phase: 'incomplete', remainingCorrectCount: 2 });
  const multiComplete = (idx: number) => setVerdict(idx, { phase: 'resolved', isResolvedCorrect: true, remainingCorrectCount: 0 });
  const timedOutUnanswered = (idx: number) => setVerdict(idx, { phase: 'expired', isResolvedCorrect: null });

  /** Declare a question multi-answer so the multi completion rule applies. */
  const asMulti = (idx: number) => {
    quizServiceMock.questions[idx].type = QuestionType.MultipleAnswer;
  };

  beforeEach(() => {
    currentIdxSig = signal(0);
    verdictByText = new Map<string, QuestionVerdictState>();
    verdictTick = signal(0);
    quizServiceMock = {
      // Real signal so the computed tracks it and re-runs on changes.
      currentQuestionIndexSig: currentIdxSig,
      currentQuestionIndex: 0,
      totalQuestions: () => 6,
      quizId: "integration-quiz",
      questions: Array.from({ length: 6 }, (_, i) => ({
        questionText: `Q${i} text`,
        type: QuestionType.SingleAnswer,
        options: []
      })),
      getQuestionsInDisplayOrder: () => quizServiceMock.questions,
      shuffledQuestions: [],
      quizInitialState: [],
      isShuffleEnabled: jest.fn().mockReturnValue(false),
      currentQuestion: { value: null },
      scoringService: { questionCorrectness: new Map() },
      questionResolved: new Map(),
      getCurrentQuestionIndex: () => currentIdxSig(),
    };

    TestBed.configureTestingModule({
      providers: [
        SelectionMessageService,
        { provide: QuizService, useValue: quizServiceMock },
        { provide: SelectedOptionService, useValue: { selectedOptionsMap: new Map() } },
        { provide: QuizDotStatusService, useValue: { timedOutFetForced: new Set<number>() } },
        {
          provide: QuestionVerdictService,
          useValue: {
            verdictFor: (_quizId: string, text: string) => {
              verdictTick();   // signal read — mirrors the real service
              return verdictByText.get(text) ?? IDLE_VERDICT_STATE;
            },
            terminalVerdicts$: { pipe: () => ({ subscribe: () => ({ closed: true, unsubscribe() {} }) }) }
          }
        },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } },
      ],
    });
    service = TestBed.inject(SelectionMessageService);
  });

  // ── derived default ────────────────────────────────────────

  it('derives CONTINUE_MSG on Q1 unanswered', () => {
    expect(service.selectionMessageSig()).toBe(CONTINUE_MSG);
  });

  it('derives CONTINUE_MSG on any other unanswered question', () => {
    currentIdxSig.set(3);
    expect(service.selectionMessageSig()).toBe(CONTINUE_MSG);
  });

  // ── click override flow ────────────────────────────────────

  it('pushMessage at current idx is reflected by the computed signal', () => {
    service.pushMessage(NEXT_BTN_MSG, 0);
    expect(service.selectionMessageSig()).toBe(NEXT_BTN_MSG);
  });

  it('pushMessage at a non-current idx is IGNORED by the computed', () => {
    service.pushMessage(NEXT_BTN_MSG, 2);
    // Current idx is 0 — override targets idx 2 → not used
    expect(service.selectionMessageSig()).toBe(CONTINUE_MSG);
  });

  it('forceNextButtonMessage pushes NEXT_BTN_MSG for non-last questions', () => {
    service.forceNextButtonMessage(0);
    expect(service.selectionMessageSig()).toBe(NEXT_BTN_MSG);
  });

  it('forceNextButtonMessage pushes SHOW_RESULTS_MSG for the last question', () => {
    currentIdxSig.set(5);
    service.forceNextButtonMessage(5);
    expect(service.selectionMessageSig()).toBe(SHOW_RESULTS_MSG);
  });

  // ── nav transitions invalidate stale overrides ─────────────

  it('nav-away to a different idx: computed picks the NEW idx, not the override', () => {
    service.pushMessage(NEXT_BTN_MSG, 0);
    expect(service.selectionMessageSig()).toBe(NEXT_BTN_MSG);
    // Nav to Q2. Even if the nav-effect doesn't flush (test env), the computed
    // re-runs because currentQuestionIndexSig changed, and override.idx (0)
    // no longer matches current idx (1) — so the computed falls through to
    // derive(1). Q2 isn't in completed set → CONTINUE_MSG.
    currentIdxSig.set(1);
    expect(service.selectionMessageSig()).toBe(CONTINUE_MSG);
  });

  // ── revisit-answered → "Answered ✓..." ─────────────────────

  it('revisit-derivation: when override is gone, completed-set drives "Answered ✓ Click Next..."', () => {
    // The constructor-time nav-clear effect cannot be flushed under Jest
    // (TestBed.flushEffects doesn't reach root-providedIn constructor effects
    // because they're scheduled before the test harness wires its flush
    // callback). To test the post-nav state without relying on the effect,
    // we explicitly DISPLACE the override by pushing a non-completion
    // message at the intermediate idx — this is what the click pipeline
    // would do in production after the user clicks on the new question.
    singleCorrect(0);                              // the VERDICT establishes completion
    service.pushMessage(NEXT_BTN_MSG, 0);          // display only
    currentIdxSig.set(1);
    service.pushMessage('Select 1 more correct answer to continue...', 1);
    currentIdxSig.set(0);
    // Override now targets idx 1; current idx 0; override.idx !== idx
    // → derive(0); 0 is in completed-set → "Answered ✓..."
    expect(service.selectionMessageSig()).toBe(ANSWERED_NEXT);
  });

  it('revisit-derivation last Q: completed-set drives "Answered ✓ Click Show Results..."', () => {
    currentIdxSig.set(5);
    singleCorrect(5);                             // the VERDICT establishes completion
    service.pushMessage(SHOW_RESULTS_MSG, 5);     // display only
    currentIdxSig.set(4);
    service.pushMessage('Select 1 more correct answer to continue...', 4);
    currentIdxSig.set(5);
    expect(service.selectionMessageSig()).toBe(ANSWERED_SHOW);
  });

  // ── isCompletedInSession public probe ──────────────────────

  it('isCompletedInSession() reports completion once the VERDICT resolves correct', () => {
    expect(service.isCompletedInSession(0)).toBe(false);
    singleCorrect(0);
    service.pushMessage(NEXT_BTN_MSG, 0);
    expect(service.isCompletedInSession(0)).toBe(true);
    expect(service.isCompletedInSession(1)).toBe(false);
  });

  /**
   * THE REGRESSION PROOF for the architectural defect this refactor removes.
   *
   * Completion used to be recorded by matching the message TEXT, so rendering
   * "Please click the Next button" — from auto-reveal, from timer expiry, or
   * from a message computed before the verdict landed — silently claimed the
   * question was finished. Emitting a string must no longer be able to say
   * anything about whether the user answered.
   */
  it('emitting a completion-looking MESSAGE cannot make a question completed', () => {
    service.pushMessage(SHOW_RESULTS_MSG, 5);
    expect(service.isCompletedInSession(5)).toBe(false);

    service.pushMessage(NEXT_BTN_MSG, 3);
    expect(service.isCompletedInSession(3)).toBe(false);

    service.pushMessage(ANSWERED_NEXT, 2);
    expect(service.isCompletedInSession(2)).toBe(false);

    // Only the verdict can say so.
    singleCorrect(3);
    expect(service.isCompletedInSession(3)).toBe(true);
  });

  it('isCompletedInSession() ignores non-completion pushes', () => {
    service.pushMessage('Select 2 more correct answers to continue...', 1);
    expect(service.isCompletedInSession(1)).toBe(false);
  });

  // ── resetAll restores derived default ──────────────────────

  it('resetAll() clears the override; completion still follows the verdict', () => {
    singleCorrect(0);
    service.pushMessage(NEXT_BTN_MSG, 0);
    expect(service.isCompletedInSession(0)).toBe(true);

    // A later re-check can DOWNGRADE the verdict — revisiting re-submits, and
    // the live bindings do not carry the first-visit picks, so the server sees
    // a smaller selection and answers `incomplete`. Completing a question is
    // not undone by that, so the latch holds.
    clearVerdicts();
    multiPartial(0);
    expect(service.isCompletedInSession(0)).toBe(true);

    // resetAll is the quiz-restart boundary: it clears the latch, and with no
    // authorized verdict left the derived default returns.
    service.resetAll();
    clearVerdicts();
    expect(service.isCompletedInSession(0)).toBe(false);
    expect(service.selectionMessageSig()).toBe(CONTINUE_MSG);
  });

  // ── external-map leakage guard ─────────────────────────────

  it('does NOT derive "Answered ✓..." when only external questionCorrectness has the index', () => {
    // External map says Q1 correct — but the in-session push never happened.
    // The signal must not promote external maps into "Answered ✓..." text.
    quizServiceMock.scoringService.questionCorrectness.set(0, true);
    // The answered probe reads `questionResolved` now; the assertion is
    // unchanged — an external map must still not promote itself into
    // "Answered ..." text.
    quizServiceMock.questionResolved.set(0, true);
    expect(service.selectionMessageSig()).toBe(CONTINUE_MSG);
    expect(service.isCompletedInSession(0)).toBe(false);
  });

  // ── completed-set isolation across rapid nav (regression guards) ──
  //
  // These tests guard the class of regressions that hit during today's
  // A2 / A5 / E2 work. The pattern: rapid Q1→Q2→Q1→Q2 navigation in
  // shuffled mode could leak completed-set or override state across
  // indices, breaking the Next button or the multi-answer banner.

  it('completion is isolated per index (Q0 completion does not leak to Q1)', () => {
    singleCorrect(0);
    expect(service.isCompletedInSession(0)).toBe(true);
    expect(service.isCompletedInSession(1)).toBe(false);
    expect(service.isCompletedInSession(2)).toBe(false);
    expect(service.isCompletedInSession(5)).toBe(false);
  });

  it('Q0→Q1→Q0→Q1 rapid nav: both indices completed, neither leaks', () => {
    // Answer Q0 correctly
    singleCorrect(0);
    // Nav to Q1
    currentIdxSig.set(1);
    // Answer Q1 correctly
    singleCorrect(1);
    // Nav back to Q0
    currentIdxSig.set(0);
    expect(service.isCompletedInSession(0)).toBe(true);
    // Nav forward to Q1 again
    currentIdxSig.set(1);
    expect(service.isCompletedInSession(1)).toBe(true);
    // No leakage to other indices
    expect(service.isCompletedInSession(2)).toBe(false);
  });

  it('completed-set survives multiple nav cycles without spurious entries', () => {
    // Walk through Q0..Q4, mark each completed
    for (let i = 0; i < 5; i++) {
      currentIdxSig.set(i);
      singleCorrect(i);
    }
    // Now check ALL indices: 0-4 completed, 5 NOT completed
    for (let i = 0; i < 5; i++) {
      expect(service.isCompletedInSession(i)).toBe(true);
    }
    expect(service.isCompletedInSession(5)).toBe(false);
    expect(service.isCompletedInSession(99)).toBe(false);
  });

  it('non-completion pushes do not pollute the completed-set across nav', () => {
    // Multi-answer partial-correct on Q0 ("Select 1 more...")
    asMulti(0);
    multiPartial(0);
    service.pushMessage('Select 1 more correct answer to continue...', 0);
    expect(service.isCompletedInSession(0)).toBe(false);

    // Nav to Q1, complete it
    currentIdxSig.set(1);
    singleCorrect(1);

    // Nav back to Q0 — still NOT completed
    currentIdxSig.set(0);
    expect(service.isCompletedInSession(0)).toBe(false);
    expect(service.isCompletedInSession(1)).toBe(true);
  });

  it('resetAll clears completed-set entirely (no per-index leakage post-reset)', () => {
    // Complete Q0, Q2, Q4
    singleCorrect(0);
    singleCorrect(2);
    singleCorrect(4);
    expect(service.isCompletedInSession(0)).toBe(true);
    expect(service.isCompletedInSession(2)).toBe(true);
    expect(service.isCompletedInSession(4)).toBe(true);

    // resetAll is the quiz-restart boundary and clears the completion latch;
    // clearing the verdicts alone would not, because a completed question stays
    // completed even when a later re-check downgrades its verdict.
    service.resetAll();
    clearVerdicts();
    for (let i = 0; i < 6; i++) {
      expect(service.isCompletedInSession(i)).toBe(false);
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // COMPLETION CONTRACT — attempted is not completed
  //
  // Each case states a situation a user can actually be in, and asserts
  // whether the app should consider the question FINISHED. Completion drives
  // the revisit message and the Show Results gate, so a false positive tells
  // the user they answered something they did not.
  // ══════════════════════════════════════════════════════════════════

  describe('completion is established by the verdict', () => {
    it('single-answer answered CORRECTLY is completed', () => {
      singleCorrect(0);
      expect(service.isCompletedInSession(0)).toBe(true);
      expect(service.selectionMessageSig()).toBe(ANSWERED_NEXT);
    });

    it('single-answer answered WRONGLY is NOT completed', () => {
      singleWrong(0);
      expect(service.isCompletedInSession(0)).toBe(false);
      expect(service.selectionMessageSig()).not.toBe(ANSWERED_NEXT);
    });

    it('multi-answer PARTIALLY answered is NOT completed', () => {
      asMulti(0);
      multiPartial(0);
      expect(service.isCompletedInSession(0)).toBe(false);
      expect(service.selectionMessageSig()).not.toBe(ANSWERED_NEXT);
    });

    it('multi-answer FULLY answered is completed', () => {
      asMulti(0);
      multiComplete(0);
      expect(service.isCompletedInSession(0)).toBe(true);
      expect(service.selectionMessageSig()).toBe(ANSWERED_NEXT);
    });

    it('WRONG first, then completed correctly, is completed', () => {
      asMulti(0);
      multiPartial(0);
      expect(service.isCompletedInSession(0)).toBe(false);

      // The user keeps going and finishes the set. The verdict reflects the
      // FINAL state, so an earlier wrong pick does not deny them credit.
      multiComplete(0);
      expect(service.isCompletedInSession(0)).toBe(true);
    });

    it('a TIMED-OUT unanswered question is NOT completed', () => {
      timedOutUnanswered(0);
      expect(service.isCompletedInSession(0)).toBe(false);
      expect(service.selectionMessageSig()).not.toBe(ANSWERED_NEXT);
    });

    it('idle, checking and error are UNKNOWN — never completion', () => {
      expect(service.isCompletedInSession(0)).toBe(false);   // idle
      setVerdict(0, { phase: 'checking' });
      expect(service.isCompletedInSession(0)).toBe(false);
      setVerdict(0, { phase: 'error' });
      expect(service.isCompletedInSession(0)).toBe(false);
    });
  });
});
