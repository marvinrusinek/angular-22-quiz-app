import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';

import { SelectedOption } from '@shared/models/SelectedOption.model';

import { AnswerEvaluationService } from './answer-evaluation.service';
import { NextButtonStateService } from './next-button-state.service';
import { OptionFeedbackStateService } from './option-feedback-state.service';
import { OptionIdResolverService } from './option-id-resolver.service';
import { OptionLockStateService } from './option-lock-state.service';
import { QuizService } from '@shared/services/data/quiz.service';
import { SelectedOptionService } from './selectedoption.service';
import { SelectionCrudService } from './selection-crud.service';
import { SelectionPersistenceService } from './selection-persistence.service';

describe('SelectedOptionService', () => {
  let service: SelectedOptionService;

  const quizReset$ = new Subject<void>();
  const currentQuestionIndex$ = new Subject<number>();

  const mockQuizService = {
    currentQuestionIndex$,
    quizReset$,
    currentQuestionIndex: 0,
    getCurrentQuestionIndex: () => 0,
    currentQuestionIndexSig: () => 0,
    updateUserAnswer: jest.fn()
  };

  const mockNextButtonStateService = {
    setNextButtonState: jest.fn()
  };

  const mockIdResolver = {
    normalizeQuestionIndex: jest.fn((idx: number) => idx),
    normalizeOptionId: jest.fn((id: any) => id),
    normalizeStr: jest.fn((s: any) => s),
    normalizeIdx: jest.fn((idx: number) => idx),
    coerceToBoolean: jest.fn((v: any) => !!v),
    buildCanonicalSelectionSnapshot: jest.fn(() => []),
    canonicalizeSelectionsForQuestion: jest.fn((_idx: number, sels: any[]) => sels),
    overlaySelectedByIdentity: jest.fn((canonical: any[], _ui: any[]) => canonical),
    resolveOptionIndexFromSelection: jest.fn(() => -1)
  };

  const mockLockState = {
    clearAll: jest.fn(),
    _lockedOptionsMap: new Map<number, Set<number>>(),
    clearLockedOptionsMap: jest.fn(),
    isOptionLocked: jest.fn(() => false),
    lockOption: jest.fn(),
    unlockOption: jest.fn(),
    unlockAllOptionsForQuestion: jest.fn(),
    lockMany: jest.fn(),
    lockQuestion: jest.fn(),
    unlockQuestion: jest.fn(),
    isQuestionLocked: jest.fn(() => false),
    resetLocksForQuestion: jest.fn()
  };

  const mockFeedbackState = {
    clearAll: jest.fn(),
    deleteFeedbackForQuestion: jest.fn(),
    getFeedbackForQuestion: jest.fn(() => ({})),
    republishFeedbackForQuestion: jest.fn(),
    syncFeedbackForQuestion: jest.fn()
  };

  const mockPersistence = {
    loadState: jest.fn(),
    saveState: jest.fn(),
    clearSessionKeys: jest.fn(),
    clearPerQuestionSessionKey: jest.fn(),
    persistAnswerForResults: jest.fn(),
    recoverAnswersForResults: jest.fn(),
    clearAnswersForResults: jest.fn()
  };

  const mockSelectionCrud = {
    syncSelectionState: jest.fn(),
    addOption: jest.fn(),
    removeOption: jest.fn(),
    setSelectedOption: jest.fn(),
    setSelectedOptions: jest.fn(),
    setSelectedOptionsForQuestion: jest.fn(),
    setSelectionsForQuestion: jest.fn(),
    selectOption: jest.fn(),
    addSelectedOptionIndex: jest.fn(),
    removeSelectedOptionIndex: jest.fn(),
    addSelection: jest.fn(),
    updateSelectionState: jest.fn(),
    updateSelectedOptions: jest.fn()
  };

  const mockAnswerEval = {
    areAllCorrectAnswersSelected: jest.fn(() => false),
    isMultiAnswerQuestion: jest.fn(() => false),
    isQuestionComplete: jest.fn(() => false),
    isQuestionResolvedCorrectly: jest.fn(() => false),
    getResolutionStatus: jest.fn(() => null)
  };

  function makeOption(overrides: Partial<SelectedOption> = {}): SelectedOption {
    return {
      text: 'Option A',
      optionId: 1,
      displayIndex: 0,
      ...overrides
    } as SelectedOption;
  }

  beforeEach(() => {
    jest.clearAllMocks();

    TestBed.configureTestingModule({
      providers: [
        SelectedOptionService,
        { provide: QuizService, useValue: mockQuizService },
        { provide: NextButtonStateService, useValue: mockNextButtonStateService },
        { provide: OptionIdResolverService, useValue: mockIdResolver },
        { provide: OptionLockStateService, useValue: mockLockState },
        { provide: OptionFeedbackStateService, useValue: mockFeedbackState },
        { provide: AnswerEvaluationService, useValue: mockAnswerEval },
        { provide: SelectionPersistenceService, useValue: mockPersistence },
        { provide: SelectionCrudService, useValue: mockSelectionCrud }
      ]
    });

    service = TestBed.inject(SelectedOptionService);
  });

  // ---------- basic instantiation ----------

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('should call persistence.loadState on construction', () => {
    expect(mockPersistence.loadState).toHaveBeenCalled();
  });

  // ---------- selectedOptionsMap ----------

  it('should start with an empty selectedOptionsMap', () => {
    expect(service.selectedOptionsMap.size).toBe(0);
  });

  it('should allow setting and getting entries in selectedOptionsMap', () => {
    const opt = makeOption();
    service.selectedOptionsMap.set(0, [opt]);
    expect(service.selectedOptionsMap.get(0)).toEqual([opt]);
  });

  // ---------- addToSelectionHistory ----------

  it('should accumulate entries via addToSelectionHistory', () => {
    const a = makeOption({ optionId: 1, displayIndex: 0 });
    const b = makeOption({ optionId: 2, displayIndex: 1 });

    service.addToSelectionHistory(0, [a]);
    service.addToSelectionHistory(0, [b]);

    const history = service._selectionHistory.get(0)!;
    expect(history).toHaveLength(2);
    expect(history[0].optionId).toBe(1);
    expect(history[1].optionId).toBe(2);
  });

  it('should deduplicate by optionId + displayIndex', () => {
    const a = makeOption({ optionId: 1, displayIndex: 0 });
    const aDuplicate = makeOption({ optionId: 1, displayIndex: 0, text: 'Different text' });

    service.addToSelectionHistory(0, [a]);
    service.addToSelectionHistory(0, [aDuplicate]);

    expect(service._selectionHistory.get(0)).toHaveLength(1);
  });

  it('should allow same optionId with different displayIndex', () => {
    const a = makeOption({ optionId: 1, displayIndex: 0 });
    const b = makeOption({ optionId: 1, displayIndex: 1 });

    service.addToSelectionHistory(0, [a, b]);

    expect(service._selectionHistory.get(0)).toHaveLength(2);
  });

  it('should keep separate histories per question index', () => {
    service.addToSelectionHistory(0, [makeOption({ optionId: 1, displayIndex: 0 })]);
    service.addToSelectionHistory(1, [makeOption({ optionId: 2, displayIndex: 0 })]);

    expect(service._selectionHistory.get(0)).toHaveLength(1);
    expect(service._selectionHistory.get(1)).toHaveLength(1);
  });

  // ---------- hasRefreshBackup / getRefreshBackup / clearRefreshBackup ----------

  it('should report hasRefreshBackup as false when empty', () => {
    expect(service.hasRefreshBackup).toBe(false);
  });

  it('should report hasRefreshBackup as true after setting backup', () => {
    service._refreshBackup.set(0, [makeOption()]);
    expect(service.hasRefreshBackup).toBe(true);
  });

  it('should return empty array from getRefreshBackup for missing index', () => {
    expect(service.getRefreshBackup(99)).toEqual([]);
  });

  it('should return stored backup from getRefreshBackup', () => {
    const opt = makeOption({ optionId: 5 });
    service._refreshBackup.set(2, [opt]);
    expect(service.getRefreshBackup(2)).toEqual([opt]);
  });

  it('should clear all backup entries via clearRefreshBackup', () => {
    service._refreshBackup.set(0, [makeOption()]);
    service._refreshBackup.set(1, [makeOption({ optionId: 2 })]);

    service.clearRefreshBackup();

    expect(service.hasRefreshBackup).toBe(false);
    expect(service._refreshBackup.size).toBe(0);
  });

  // ---------- clearState ----------

  it('should clear all maps and arrays via clearState', () => {
    service.selectedOptionsMap.set(0, [makeOption()]);
    service.rawSelectionsMap.set(0, [{ optionId: 1, text: 'A' }]);
    service._selectionHistory.set(0, [makeOption()]);
    service.selectedOption = [makeOption()];
    service.selectedOptionIndices = { 0: [1] };

    service.clearState();

    expect(service.selectedOptionsMap.size).toBe(0);
    expect(service.rawSelectionsMap.size).toBe(0);
    expect(service._selectionHistory.size).toBe(0);
    expect(service.selectedOption).toEqual([]);
    expect(service.selectedOptionIndices).toEqual({});
    expect(mockFeedbackState.clearAll).toHaveBeenCalled();
    expect(mockLockState.clearAll).toHaveBeenCalled();
    expect(mockPersistence.clearSessionKeys).toHaveBeenCalled();
  });

  // ---------- resetAllOptions ----------

  it('should reset signals and clear state via resetAllOptions', () => {
    service.selectedOptionsMap.set(0, [makeOption()]);

    service.resetAllOptions();

    expect(service.selectedOptionsMap.size).toBe(0);
    expect(service.isOptionSelectedSig()).toBe(false);
    expect(service.isAnsweredSig()).toBe(false);
    expect(service.selectedOptionSig()).toEqual([]);
  });

  // ---------- lastClickedCorrectByQuestion ----------

  it('should store and retrieve lastClickedCorrectByQuestion entries', () => {
    service.lastClickedCorrectByQuestion.set(0, true);
    service.lastClickedCorrectByQuestion.set(1, false);

    expect(service.lastClickedCorrectByQuestion.get(0)).toBe(true);
    expect(service.lastClickedCorrectByQuestion.get(1)).toBe(false);
  });

  // ---------- clickConfirmedDotStatus ----------

  it('should store and retrieve clickConfirmedDotStatus entries', () => {
    service.clickConfirmedDotStatus.set(0, 'correct');
    service.clickConfirmedDotStatus.set(1, 'wrong');

    expect(service.clickConfirmedDotStatus.get(0)).toBe('correct');
    expect(service.clickConfirmedDotStatus.get(1)).toBe('wrong');
  });

  it('should allow overwriting clickConfirmedDotStatus for a question', () => {
    service.clickConfirmedDotStatus.set(0, 'wrong');
    service.clickConfirmedDotStatus.set(0, 'correct');

    expect(service.clickConfirmedDotStatus.get(0)).toBe('correct');
  });

  // ---------- quizReset$ subscription ----------

  it('should reset all options when quizReset$ emits', () => {
    service.selectedOptionsMap.set(0, [makeOption()]);

    quizReset$.next();

    expect(service.selectedOptionsMap.size).toBe(0);
    expect(service.selectedOptionSig()).toEqual([]);
  });
});