import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';

import { Option } from '../../../models/Option.model';
import { OptionBindings } from '../../../models/OptionBindings.model';

import { SK_SEL_Q } from '../../../constants/session-keys';

import { ExplanationTextService } from '../../features/explanation/explanation-text.service';
import { FeedbackService } from '../../features/feedback/feedback.service';
import { OptionBindingFactoryService } from './option-binding-factory.service';
import { OptionClickHandlerService } from './option-click-handler.service';
import { OptionService } from '../view/option.service';
import { QuestionResolutionService } from './question-resolution.service';
import { QuizService } from '../../data/quiz.service';
import { SelectedOptionService } from '../../state/selectedoption.service';

import { SharedOptionBindingService } from './shared-option-binding.service';

/**
 * Unit coverage for SharedOptionBindingService (added 2026-06-27 per the
 * CODE_REVIEW roadmap — a top-LOC service with ~0 unit tests). Most of this
 * service mutates a passed `comp` host object through many intertwined init
 * paths that the e2e net already exercises end-to-end; pinning those here would
 * be brittle. So scope is the deterministic, value-returning surface: option-
 * binding construction, the saved-selection id/text/index matching helpers,
 * the selected-flag sync (incl. its id-collision guard), the force-disable
 * toggles, and render-ready gating.
 */
describe('SharedOptionBindingService', () => {
  let service: SharedOptionBindingService;
  let selectedOptionService: any;

  // jsdom (this jest env) lacks structuredClone, which the service uses for
  // option deep-clones; a JSON clone is sufficient for plain option data.
  beforeAll(() => {
    if (typeof (globalThis as any).structuredClone !== 'function') {
      (globalThis as any).structuredClone = (v: any) => JSON.parse(JSON.stringify(v));
    }
  });

  // Minimal host stub; override per test.
  const makeComp = (over: any = {}): any => ({
    optionsToDisplay: [] as Option[],
    showFeedback: () => false,
    showFeedbackForOption: {},
    highlightCorrectAfterIncorrect: () => false,
    shouldResetBackground: () => false,
    resolveInteractionType: () => 'single',
    computeDisabledState: () => false,
    handleOptionClick: jest.fn(),
    cdRef: { markForCheck: jest.fn(), detectChanges: jest.fn() },
    ...over
  });

  // Bindings whose backing array survives across optionBindings() calls so the
  // mutating methods can be observed.
  const compWithBindings = (bindings: OptionBindings[], over: any = {}): any =>
    makeComp({ optionBindings: () => bindings, ...over });

  beforeEach(() => {
    selectedOptionService = {
      getSelectedOptionsForQuestion: jest.fn(() => []),
      unlockQuestion: jest.fn(),
      unlockAllOptionsForQuestion: jest.fn()
    };

    TestBed.configureTestingModule({
      providers: [
        SharedOptionBindingService,
        { provide: OptionClickHandlerService, useValue: {} },
        { provide: ExplanationTextService, useValue: { latestExplanation: '', latestExplanationIndex: -1 } },
        { provide: FeedbackService, useValue: { buildFeedbackMessage: jest.fn(() => ''), setCorrectMessage: jest.fn(() => '') } },
        { provide: OptionBindingFactoryService, useValue: { createBindings: jest.fn(() => []) } },
        { provide: OptionService, useValue: { keyOf: jest.fn() } },
        { provide: QuestionResolutionService, useValue: { resolveQuestionState: jest.fn(() => ({ dot: '', fullyResolvedCorrect: false })) } },
        {
          provide: QuizService,
          useValue: {
            questions: [],
            shuffledQuestions: [],
            isShuffleEnabled: () => false,
            getCurrentQuestionIndex: () => 0,
            multipleAnswer: false
          }
        },
        { provide: SelectedOptionService, useValue: selectedOptionService }
      ]
    });
    service = TestBed.inject(SharedOptionBindingService);
  });

  // ── getOptionBindings ───────────────────────────────────────────
  describe('getOptionBindings', () => {
    const correctOpt: Option = { optionId: 1, text: 'Right', correct: true };
    const wrongOpt: Option = { optionId: 2, text: 'Wrong', correct: false };

    // Input type follows the question's resolved TYPE, not a count of correct
    // options. Counting made a rendering decision depend on the answer key,
    // and would collapse every question to a radio group once options arrive
    // from the API carrying no correctness.
    it('renders radio for a single-answer question', () => {
      const comp = makeComp({
        optionsToDisplay: [correctOpt, wrongOpt],
        resolveInteractionType: () => 'single'
      });
      const b = service.getOptionBindings(comp, correctOpt, 0);
      expect(b.appHighlightInputType).toBe('radio');
    });

    it('renders checkbox for a multiple-answer question', () => {
      const comp = makeComp({
        optionsToDisplay: [correctOpt, wrongOpt],
        resolveInteractionType: () => 'multiple'
      });
      const b = service.getOptionBindings(comp, correctOpt, 0);
      expect(b.appHighlightInputType).toBe('checkbox');
    });

    it('renders radio for a single-answer question even when several options are flagged correct', () => {
      // The count says multiple; the resolved type says single. The type wins.
      const lying = [correctOpt, { ...wrongOpt, correct: true }];
      const comp = makeComp({
        optionsToDisplay: lying,
        resolveInteractionType: () => 'single'
      });
      expect(service.getOptionBindings(comp, correctOpt, 0).appHighlightInputType).toBe('radio');
    });

    // Selection is tracked; correctness is not asserted. A binding is built
    // before any verdict exists, so claiming either answer would be a guess —
    // and `false` specifically would mean "a verdict said wrong".
    it('tracks selection without claiming correctness for a correct option', () => {
      const comp = makeComp({ optionsToDisplay: [correctOpt, wrongOpt] });
      const b = service.getOptionBindings(comp, correctOpt, 0, true);
      expect(b.isSelected).toBe(true);
      expect(b.checked).toBe(true);
      expect(b.isCorrect).toBeNull();
      expect(b.highlightCorrect).toBe(false);
      expect(b.highlightIncorrect).toBe(false);
    });

    it('does not mark a selected wrong option incorrect either', () => {
      const comp = makeComp({ optionsToDisplay: [correctOpt, wrongOpt] });
      const b = service.getOptionBindings(comp, wrongOpt, 1, true);
      expect(b.isCorrect).toBeNull();
      expect(b.highlightIncorrect).toBe(false);
      expect(b.highlightCorrect).toBe(false);
    });

    it('builds from an option with NO `correct` property at all', () => {
      // The shape GET /questions returns: text and nothing else.
      const bare = { optionId: 9, text: 'Bare' } as Option;
      const comp = makeComp({ optionsToDisplay: [bare] });
      const b = service.getOptionBindings(comp, bare, 0);

      expect(b.option.text).toBe('Bare');
      expect(b.isCorrect).toBeNull();
      expect(b.appHighlightInputType).toBe('radio');
    });

    it('defaults feedback text and deep-clones the option', () => {
      const opt: Option = { optionId: 3, text: 'NoFeedback', correct: false };
      const comp = makeComp({ optionsToDisplay: [opt] });
      const b = service.getOptionBindings(comp, opt, 0);
      expect(b.feedback).toBe('No feedback available');
      expect(b.option).not.toBe(opt);          // structuredClone -> new ref
      expect(b.option.text).toBe('NoFeedback');
      expect(b.ariaLabel).toBe('Option 1');
      expect(b.index).toBe(0);
    });
  });

  // ── toIdSet (private, pure) ─────────────────────────────────────
  describe('toIdSet', () => {
    const toIdSet = (saved: any[]) => (service as any).toIdSet(saved);

    it('collects ids, skipping selected:false and id-less entries', () => {
      const set = toIdSet([
        { optionId: 1, selected: true },
        { optionId: 2 },
        { optionId: 3, selected: false },
        { selected: true }
      ]);
      expect(set.has(1)).toBe(true);
      expect(set.has(2)).toBe(true);
      expect(set.has(3)).toBe(false);
      expect(set.size).toBe(2);
    });

    it('returns an empty set for null/empty input', () => {
      expect(toIdSet(null as any).size).toBe(0);
      expect(toIdSet([]).size).toBe(0);
    });
  });

  // ── markRenderReady ─────────────────────────────────────────────
  describe('markRenderReady', () => {
    it('sets + emits render-ready when bindings and options are present', () => {
      const renderReady = { set: jest.fn() };
      const renderReadyChange = { emit: jest.fn() };
      const comp = makeComp({
        optionBindings: () => [{} as OptionBindings],
        optionsToDisplay: [{ text: 'a' }],
        renderReady,
        renderReadyChange
      });
      service.markRenderReady(comp);
      expect(renderReady.set).toHaveBeenCalledWith(true);
      expect(renderReadyChange.emit).toHaveBeenCalledWith(true);
    });

    it('does nothing when bindings or options are empty', () => {
      const renderReady = { set: jest.fn() };
      const renderReadyChange = { emit: jest.fn() };
      const comp = makeComp({
        optionBindings: () => [],
        optionsToDisplay: [],
        renderReady,
        renderReadyChange
      });
      service.markRenderReady(comp);
      expect(renderReady.set).not.toHaveBeenCalled();
      expect(renderReadyChange.emit).not.toHaveBeenCalled();
    });
  });

  // ── syncSelectedFlags ───────────────────────────────────────────
  describe('syncSelectedFlags', () => {
    it('selects bindings whose optionId is in the selected map', () => {
      const bindings: any[] = [
        { option: { optionId: 5 }, isSelected: false },
        { option: { optionId: 6 }, isSelected: false }
      ];
      const comp = compWithBindings(bindings, {
        selectedOptionMap: new Map([[5, true]]),
        selectedOptionHistory: []
      });
      service.syncSelectedFlags(comp);
      expect(bindings[0].isSelected).toBe(true);
      expect(bindings[0].option.selected).toBe(true);
      expect(bindings[1].isSelected).toBe(false);
    });

    it('falls back to selection history when not in the map', () => {
      const bindings: any[] = [{ option: { optionId: 9 }, isSelected: false }];
      const comp = compWithBindings(bindings, {
        selectedOptionMap: new Map(),
        selectedOptionHistory: [9]
      });
      service.syncSelectedFlags(comp);
      expect(bindings[0].isSelected).toBe(true);
    });

    it('does not select an id-less binding whose index collides with a real id', () => {
      // binding[0] has real id 1; binding[1] has no id so falls back to index 1,
      // which collides with binding[0]'s id -> guard must keep it unselected.
      const bindings: any[] = [
        { option: { optionId: 1 }, isSelected: false },
        { option: {}, isSelected: false }
      ];
      const comp = compWithBindings(bindings, {
        selectedOptionMap: new Map([[1, true]]),
        selectedOptionHistory: []
      });
      service.syncSelectedFlags(comp);
      expect(bindings[0].isSelected).toBe(true);
      expect(bindings[1].isSelected).toBe(false);
    });
  });

  // ── force-disable toggles ───────────────────────────────────────
  describe('force-disable toggles', () => {
    it('forceDisableAllOptions deactivates every binding + option', () => {
      const bindings: any[] = [{ option: { active: true } }, { option: { active: true } }];
      const optionsToDisplay: any[] = [{ active: true }, { active: true }];
      const forceDisableAll = { set: jest.fn() };
      const comp = compWithBindings(bindings, {
        optionsToDisplay,
        forceDisableAll,
        clickService: { updateBindingSnapshots: jest.fn() }
      });
      service.forceDisableAllOptions(comp);
      expect(forceDisableAll.set).toHaveBeenCalledWith(true);
      expect(bindings.every(b => b.option.active === false)).toBe(true);
      expect(optionsToDisplay.every(o => o.active === false)).toBe(true);
    });

    it('clearForceDisableAllOptions reactivates everything + unlocks the question', () => {
      const bindings: any[] = [{ option: { active: false } }];
      const optionsToDisplay: any[] = [{ active: false }];
      const forceDisableAll = { set: jest.fn() };
      const comp = compWithBindings(bindings, {
        optionsToDisplay,
        forceDisableAll,
        currentQuestionIndex: 2,
        clickService: { updateBindingSnapshots: jest.fn() }
      });
      service.clearForceDisableAllOptions(comp);
      expect(forceDisableAll.set).toHaveBeenCalledWith(false);
      expect(bindings[0].option.active).toBe(true);
      expect(optionsToDisplay[0].active).toBe(true);
      expect(selectedOptionService.unlockQuestion).toHaveBeenCalledWith(2);
    });
  });

  // ── saved-selection matching (private helpers) ──────────────────
  describe('saved-selection matching', () => {
    let store: Record<string, string>;

    beforeEach(() => {
      store = {};
      jest.spyOn(Storage.prototype, 'getItem').mockImplementation((k) => store[k] ?? null);
      jest.spyOn(Storage.prototype, 'setItem').mockImplementation((k, v) => { store[k] = String(v); });
    });

    afterEach(() => jest.restoreAllMocks());

    describe('findSavedSelectionMatch', () => {
      const find = (qIndex: number, b: OptionBindings, i: number) =>
        (service as any).findSavedSelectionMatch(qIndex, b, i);

      it('matches a saved entry by text (shuffle-immune)', () => {
        store[SK_SEL_Q + 0] = JSON.stringify([{ text: 'Beta' }]);
        const b = { option: { text: 'beta' } } as OptionBindings;
        expect(find(0, b, 0)).toEqual({ text: 'Beta' });
      });

      it('does not match when the text differs', () => {
        store[SK_SEL_Q + 0] = JSON.stringify([{ text: 'Beta' }]);
        const b = { option: { text: 'Alpha' } } as OptionBindings;
        expect(find(0, b, 0)).toBeUndefined();
      });

      it('falls back to displayIndex when the saved entry has no text', () => {
        store[SK_SEL_Q + 1] = JSON.stringify([{ displayIndex: 2 }]);
        const b = { option: { text: 'x' } } as OptionBindings;
        expect(find(1, b, 2)).toEqual({ displayIndex: 2 });
      });
    });

    describe('resolveSavedBindingPosition', () => {
      const resolve = (comp: any, s: any, sText: string) =>
        (service as any).resolveSavedBindingPosition(comp, s, sText);

      it('resolves a position by normalized text', () => {
        const comp = makeComp({
          optionBindings: () => [{ option: { text: 'A' } }, { option: { text: 'B' } }]
        });
        expect(resolve(comp, { text: 'B' }, 'b')).toBe(1);
      });

      it('falls back to displayIndex when the entry has no text', () => {
        const comp = makeComp({ optionBindings: () => [{ option: { text: 'A' } }] });
        expect(resolve(comp, { displayIndex: 0 }, '')).toBe(0);
      });
    });
  });

  // ── generateOptionBindings: question-index stamp (S6k) ───────────
  //
  // ROOT CAUSE this stamp fixes: SharedOptionComponent.ngDoCheck() runs on
  // every CD cycle and unconditionally publishes optionBindings() to
  // SelectedOptionService.setUiSelectedTextsForQuestion() — which submits any
  // NON-IDENTICAL value straight to POST /check. During a Next-triggered
  // transition, several CD cycles fire BEFORE generateOptionBindings() has
  // rebuilt bindings for the new question — first with the PREVIOUS
  // question's bindings still in place, then with them cleared to empty —
  // and each of those transient values used to reach the backend as if it
  // were a real user selection. This is why a healthy baseline traced 21
  // POST /check calls for a 7-question DI quiz that structurally needs only
  // 9: 1 clean call for Q1 (loaded directly, no transition) and 3 for every
  // Next-reached question (stale, empty, then the real one) — a pattern that
  // happens to self-resolve on baseline timing but does not once Introduction
  // does one more async fetch before Start Quiz.
  //
  // The fix: generateOptionBindings() stamps which question index it just
  // built bindings FOR. syncUiSelectedTexts() compares that stamp to the
  // currently active question index and skips publishing on mismatch — so
  // leftover Q(N-1) bindings, or bindings mid-rebuild, can never reach
  // POST /check for Q(N).
  describe('generateOptionBindings — question-index stamp', () => {
    const makeGenComp = (over: any = {}): any => ({
      hasUserClicked: () => false,
      getActiveQuestionIndex: () => 1,
      optionsToDisplay: [{ optionId: 1, text: 'A' }],
      currentQuestion: () => ({ questionText: 'Q', answer: [] }),
      resolveInteractionType: () => 'single',
      showFeedback: () => false,
      showFeedbackForOption: {},
      highlightCorrectAfterIncorrect: () => false,
      shouldResetBackground: () => false,
      computeDisabledState: () => false,
      optionBindings: signal<OptionBindings[]>([]),
      optionBindingsQuestionIndex: signal<number | null>(null),
      rehydrateUiFromState: jest.fn(),
      cdRef: { markForCheck: jest.fn(), detectChanges: jest.fn() },
      feedbackConfigs: {},
      rebuildShowFeedbackMapFromBindings: jest.fn(),
      showOptions: signal(false),
      optionsReady: false,
      renderReady: signal(false),
      markRenderReady: jest.fn(),
      ...over
    });

    it('stamps optionBindingsQuestionIndex with the question the bindings were built for', () => {
      const comp = makeGenComp({ getActiveQuestionIndex: () => 2 });
      service.generateOptionBindings(comp);
      expect(comp.optionBindingsQuestionIndex()).toBe(2);
    });

    it('does NOT stamp (and does not rebuild) when hasUserClicked short-circuits with existing bindings', () => {
      const comp = makeGenComp({
        hasUserClicked: () => true,
        optionBindings: signal<OptionBindings[]>([{ option: { text: 'stale' } } as OptionBindings]),
        getActiveQuestionIndex: () => 2
      });
      service.generateOptionBindings(comp);
      // The early-return means the stamp is never touched for this call —
      // proving a leftover stamp from a PRIOR question stays mismatched
      // (and therefore un-published) until a real rebuild happens.
      expect(comp.optionBindingsQuestionIndex()).toBeNull();
    });

    it('a fresh rebuild for question 0 stamps 0 (not confused with the null default)', () => {
      const comp = makeGenComp({ getActiveQuestionIndex: () => 0 });
      service.generateOptionBindings(comp);
      expect(comp.optionBindingsQuestionIndex()).toBe(0);
    });
  });
});
