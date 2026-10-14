import { TestBed } from '@angular/core/testing';

import { QuizStateService } from './quizstate.service';

describe('QuizStateService', () => {
  let service: QuizStateService;
  let store: Record<string, string>;

  beforeEach(() => {
    // Mock sessionStorage
    store = {};
    jest
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation((key: string) => store[key] ?? null);
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation((key: string, value: string) => {
      store[key] = value;
    });
    jest.spyOn(Storage.prototype, 'removeItem').mockImplementation((key: string) => {
      delete store[key];
    });

    // Mock performance.getEntriesByType to return non-reload so constructor skips restore
    (performance as any).getEntriesByType = jest
      .fn()
      .mockReturnValue([{ type: 'navigate' } as any]);

    TestBed.configureTestingModule({ providers: [QuizStateService] });
    service = TestBed.inject(QuizStateService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── Basic instantiation ──────────────────────────────────────────

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  // ── Signal defaults ──────────────────────────────────────────────

  it('should initialise currentQuestionSig to null', () => {
    expect(service.currentQuestionSig()).toBeNull();
  });

  it('should initialise currentQuestionIndexSig to 0', () => {
    expect(service.currentQuestionIndexSig()).toBe(0);
  });

  it('should initialise isLoadingSig to false', () => {
    expect(service.isLoadingSig()).toBe(false);
  });

  it('should initialise isNavigatingSig to false', () => {
    expect(service.isNavigatingSig()).toBe(false);
  });

  it('should initialise isAnsweredSig to false', () => {
    expect(service.isAnsweredSig()).toBe(false);
  });

  it('should initialise explanationReadySig to false', () => {
    expect(service.explanationReadySig()).toBe(false);
  });

  it('should initialise displayStateSig to question/unanswered', () => {
    expect(service.displayStateSig()).toEqual({ mode: 'question', answered: false });
  });

  it('should initialise interactionReadySig to true', () => {
    expect(service.interactionReadySig()).toBe(true);
  });

  // ── setLoading / isLoading ───────────────────────────────────────

  it('setLoading should update the loading signal', () => {
    service.setLoading(true);
    expect(service.isLoadingSig()).toBe(true);
    expect(service.isLoading()).toBe(true);

    service.setLoading(false);
    expect(service.isLoading()).toBe(false);
  });

  it('startLoading should set loading to true only when not already loading', () => {
    service.startLoading();
    expect(service.isLoading()).toBe(true);

    // Calling again should still be true (no-op, no error)
    service.startLoading();
    expect(service.isLoading()).toBe(true);
  });

  // ── setNavigating ────────────────────────────────────────────────

  it('setNavigating should update the navigating signal', () => {
    service.setNavigating(true);
    expect(service.isNavigatingSig()).toBe(true);

    service.setNavigating(false);
    expect(service.isNavigatingSig()).toBe(false);
  });

  // ── setAnswered ──────────────────────────────────────────────────

  it('setAnswered should update the answered signal', () => {
    service.setAnswered(true);
    expect(service.isAnsweredSig()).toBe(true);
  });

  // ── setAnswerSelected ────────────────────────────────────────────

  it('setAnswerSelected should set isAnswered and lock displayExplanation', () => {
    expect(service.displayExplanationLocked).toBe(false);

    service.setAnswerSelected(true);
    expect(service.isAnsweredSig()).toBe(true);
    expect(service.displayExplanationLocked).toBe(true);
  });

  it('setAnswerSelected(false) should not lock displayExplanation', () => {
    service.setAnswerSelected(false);
    expect(service.isAnsweredSig()).toBe(false);
    expect(service.displayExplanationLocked).toBe(false);
  });

  // ── setExplanationReady ──────────────────────────────────────────

  it('setExplanationReady should update the explanationReady signal', () => {
    service.setExplanationReady(true);
    expect(service.explanationReadySig()).toBe(true);
  });

  // ── setDisplayState ──────────────────────────────────────────────

  it('setDisplayState should update the display state signal', () => {
    service.setDisplayState({ mode: 'explanation', answered: true });
    expect(service.displayStateSig()).toEqual({ mode: 'explanation', answered: true });
  });

  it('setDisplayState should be blocked when visibility restore lock is active', () => {
    service.lockDisplayStateForVisibilityRestore(5000);

    service.setDisplayState({ mode: 'explanation', answered: true });
    // Should remain at default because the lock blocked the update
    expect(service.displayStateSig()).toEqual({ mode: 'question', answered: false });
  });

  it('setDisplayState with force option should bypass the visibility restore lock', () => {
    service.lockDisplayStateForVisibilityRestore(5000);

    service.setDisplayState({ mode: 'explanation', answered: true }, { force: true });
    expect(service.displayStateSig()).toEqual({ mode: 'explanation', answered: true });
  });

  // ── setInteractionReady / isInteractionReady ─────────────────────

  it('setInteractionReady should update the interaction ready signal', () => {
    service.setInteractionReady(false);
    expect(service.isInteractionReady()).toBe(false);

    service.setInteractionReady(true);
    expect(service.isInteractionReady()).toBe(true);
  });

  // ── markUserInteracted / hasUserInteracted ───────────────────────

  it('markUserInteracted should track the given index', () => {
    expect(service.hasUserInteracted(2)).toBe(false);

    service.markUserInteracted(2);
    expect(service.hasUserInteracted(2)).toBe(true);
    expect(service.userHasInteractedSig()).toBe(2);
  });

  it('markUserInteracted should persist to sessionStorage', () => {
    service.markUserInteracted(0);
    expect(sessionStorage.setItem).toHaveBeenCalled();
  });

  // ── markQuestionAnswered / isQuestionAnswered ────────────────────

  it('markQuestionAnswered should track the given index', () => {
    expect(service.isQuestionAnswered(3)).toBe(false);

    service.markQuestionAnswered(3);
    expect(service.isQuestionAnswered(3)).toBe(true);
  });

  // ── markClickedInSession / hasClickedInSession / clearClickedInSession ──

  it('markClickedInSession should track the index', () => {
    expect(service.hasClickedInSession(1)).toBe(false);

    service.markClickedInSession(1);
    expect(service.hasClickedInSession(1)).toBe(true);
  });

  it('markClickedInSession should reject negative indices', () => {
    service.markClickedInSession(-1);
    expect(service.hasClickedInSession(-1)).toBe(false);
  });

  it('clearClickedInSession should remove all tracked clicks', () => {
    service.markClickedInSession(0);
    service.markClickedInSession(1);
    service.clearClickedInSession();
    expect(service.hasClickedInSession(0)).toBe(false);
    expect(service.hasClickedInSession(1)).toBe(false);
  });

  // ── resetInteraction ─────────────────────────────────────────────

  it('resetInteraction should reset user interaction signals', () => {
    service.markUserInteracted(5);
    service.resetInteraction();
    expect(service.userHasInteractedSig()).toBe(-1);
    expect(service.lastInteractionTimeSig()).toBe(0);
  });

  // ── reset ────────────────────────────────────────────────────────

  it('reset should clear all state', () => {
    service.markUserInteracted(1);
    service.markQuestionAnswered(1);
    service.setAnswered(true);
    service.setExplanationReady(true);
    service.setQuestionState('quiz1', 0, { isAnswered: true, selectedOptions: [] });

    service.reset();

    expect(service._hasUserInteracted.size).toBe(0);
    expect(service._answeredQuestionIndices.size).toBe(0);
    expect(service.isAnsweredSig()).toBe(false);
    expect(service.explanationReadySig()).toBe(false);
    expect(service.currentQuestionSig()).toBeNull();
    expect(service.userHasInteractedSig()).toBe(-1);
    expect(sessionStorage.removeItem).toHaveBeenCalled();
  });

  // ── createDefaultQuestionState ───────────────────────────────────

  it('createDefaultQuestionState should return a fresh default state', () => {
    const state = service.createDefaultQuestionState();
    expect(state.isAnswered).toBe(false);
    expect(state.numberOfCorrectAnswers).toBe(0);
    expect(state.selectedOptions).toEqual([]);
    expect(state.explanationDisplayed).toBe(false);
  });

  // ── setQuestionState / getQuestionState ──────────────────────────

  it('setQuestionState and getQuestionState should store and retrieve state', () => {
    const state = { isAnswered: true, selectedOptions: [] };
    service.setQuestionState('q1', 0, state);

    const retrieved = service.getQuestionState('q1', 0);
    expect(retrieved).toBeDefined();
    expect(retrieved!.isAnswered).toBe(true);
  });

  it('getQuestionState should return default state for unknown question', () => {
    const state = service.getQuestionState('q1', 99);
    expect(state).toBeDefined();
    expect(state!.isAnswered).toBe(false);
  });

  // ── Visibility restore lock/unlock ───────────────────────────────

  it('unlockDisplayStateForVisibilityRestore should allow state changes again', () => {
    service.lockDisplayStateForVisibilityRestore(5000);
    service.unlockDisplayStateForVisibilityRestore();

    service.setDisplayState({ mode: 'explanation', answered: true });
    expect(service.displayStateSig()).toEqual({ mode: 'explanation', answered: true });
  });
});
