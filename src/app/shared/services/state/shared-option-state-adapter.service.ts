import { Service, WritableSignal } from '@angular/core';

import { FeedbackProps } from '@shared/models/FeedbackProps.model';
import { Option } from '@shared/models/Option.model';
import { OptionBindings } from '@shared/models/OptionBindings.model';
import { QuizQuestion } from '@shared/models/QuizQuestion.model';

import { OptionInteractionState } from '@shared/services/options/engine/option-interaction.service';

export interface SharedOptionUiState {
  selectedOptionHistory: (number | string)[];
  disabledOptionsPerQuestion: Map<number, Set<number>>;
  correctClicksPerQuestion: Map<number, Set<number>>;

  feedbackConfigs: { [key: string]: FeedbackProps };
  showFeedbackForOption: { [key: string]: boolean };

  lastFeedbackOptionId: number | string;
  lastFeedbackQuestionIndex: number;

  lastClickedOptionId: number | string | null;
  lastClickTimestamp: number | null;

  hasUserClicked: boolean;
  freezeOptionBindings: boolean;
  showFeedback: boolean;
  disableRenderTrigger: number;
  selectedOptionMap?: Map<number | string, boolean>;
}

export interface SharedOptionHost {
  optionBindings: WritableSignal<OptionBindings[]>;
  optionsToDisplay: Option[];
  currentQuestionIndex: number;

  type: 'single' | 'multiple';
  currentQuestion: WritableSignal<QuizQuestion | null>;

  ui?: SharedOptionUiState;

  // Legacy fields
  selectedOptionHistory: (number | string)[];
  disabledOptionsPerQuestion: Map<number, Set<number>>;
  correctClicksPerQuestion: Map<number, Set<number>>;

  feedbackConfigs: { [key: string]: FeedbackProps };
  showFeedbackForOption: { [key: string]: boolean };

  lastFeedbackOptionId: number | string;
  lastFeedbackQuestionIndex: number;

  lastClickedOptionId: number | string | null;
  lastClickTimestamp: number | null;

  hasUserClicked: WritableSignal<boolean>;
  freezeOptionBindings: WritableSignal<boolean>;
  showFeedback: WritableSignal<boolean>;
  disableRenderTrigger: number;

  selectedOptionMap?: Map<number | string, boolean>;
  showExplanationChange?: any;
  explanationToDisplayChange?: any;
}

@Service()
export class SharedOptionStateAdapterService {
  // ── public methods ──────────────────────────────────────────────

  // UI STATE BUNDLE HELPERS

  createInitialUiState(): SharedOptionUiState {
    return {
      selectedOptionHistory: [],
      disabledOptionsPerQuestion: new Map<number, Set<number>>(),
      correctClicksPerQuestion: new Map<number, Set<number>>(),

      feedbackConfigs: {},
      showFeedbackForOption: {},

      lastFeedbackOptionId: -1,
      lastFeedbackQuestionIndex: -1,

      lastClickedOptionId: null,
      lastClickTimestamp: null,

      hasUserClicked: false,
      freezeOptionBindings: false,
      showFeedback: false,
      disableRenderTrigger: 0,
      selectedOptionMap: new Map()
    };
  }

  /**
   * Ensure `host.ui` exists. Call this once in SOC constructor/ngOnInit,
   * then migrate SOC fields to reference host.ui.*
   */
  ensureUi(host: SharedOptionHost): SharedOptionUiState {
    if (!host.ui) host.ui = this.createInitialUiState();
    return host.ui;
  }

  resetUiForQuestion(ui: SharedOptionUiState, qIdx: number): void {
    ui.showFeedbackForOption = {};
    ui.lastFeedbackOptionId = -1;
    ui.lastFeedbackQuestionIndex = qIdx;
    ui.hasUserClicked = false;
    ui.showFeedback = false;
    ui.freezeOptionBindings = false;
  }

  // OPTION INTERACTION STATE ADAPTER (your existing behavior)
  
  /**
   * Build the state object needed by OptionInteractionService.
   * Reads from host.ui if present, otherwise falls back to legacy fields.
   */
  build(host: SharedOptionHost): OptionInteractionState {
    const ui = host.ui;

    return {
      optionBindings: host.optionBindings(),
      optionsToDisplay: host.optionsToDisplay,
      currentQuestionIndex: host.currentQuestionIndex,

      selectedOptionHistory: ui?.selectedOptionHistory ?? host.selectedOptionHistory,
      disabledOptionsPerQuestion: ui?.disabledOptionsPerQuestion ?? host.disabledOptionsPerQuestion,
      correctClicksPerQuestion: ui?.correctClicksPerQuestion ?? host.correctClicksPerQuestion,

      feedbackConfigs: ui?.feedbackConfigs ?? host.feedbackConfigs,
      showFeedbackForOption: ui?.showFeedbackForOption ?? host.showFeedbackForOption,

      lastFeedbackOptionId: ui?.lastFeedbackOptionId ?? host.lastFeedbackOptionId,
      lastFeedbackQuestionIndex: ui?.lastFeedbackQuestionIndex ?? host.lastFeedbackQuestionIndex,

      lastClickedOptionId: ui?.lastClickedOptionId ?? host.lastClickedOptionId,
      lastClickTimestamp: ui?.lastClickTimestamp ?? host.lastClickTimestamp,

      hasUserClicked: ui?.hasUserClicked ?? host.hasUserClicked(),
      freezeOptionBindings: ui?.freezeOptionBindings ?? host.freezeOptionBindings(),
      showFeedback: ui?.showFeedback ?? host.showFeedback(),
      disableRenderTrigger: ui?.disableRenderTrigger ?? host.disableRenderTrigger,

      type: host.type,
      currentQuestion: host.currentQuestion(),

      selectedOptionMap: ui?.selectedOptionMap ?? host.selectedOptionMap ?? new Map(),
      showExplanationChange: host.showExplanationChange,
      explanationToDisplayChange: host.explanationToDisplayChange
    };
  }

  /**
   * Sync changes from OptionInteractionService back to SOC.
   * Writes into host.ui if present, otherwise legacy fields.
   */
  syncBack(host: SharedOptionHost, state: OptionInteractionState): void {
    // bindings can be replaced by the interaction engine
    host.optionBindings.set(state.optionBindings);

    if (host.ui) {
      host.ui.disableRenderTrigger = state.disableRenderTrigger;
      host.ui.feedbackConfigs = state.feedbackConfigs;
      host.ui.showFeedbackForOption = state.showFeedbackForOption;
      host.ui.lastFeedbackOptionId = state.lastFeedbackOptionId;
      host.ui.lastFeedbackQuestionIndex = state.lastFeedbackQuestionIndex;
      host.ui.lastClickedOptionId = state.lastClickedOptionId;
      host.ui.lastClickTimestamp = state.lastClickTimestamp;
      host.ui.hasUserClicked = state.hasUserClicked;
      host.ui.freezeOptionBindings = state.freezeOptionBindings;
      host.ui.showFeedback = state.showFeedback;

      // also keep these maps in sync (they're part of the state object)
      host.ui.disabledOptionsPerQuestion = state.disabledOptionsPerQuestion;
      host.ui.correctClicksPerQuestion = state.correctClicksPerQuestion;
      host.ui.selectedOptionHistory = state.selectedOptionHistory;
      host.ui.selectedOptionMap = state.selectedOptionMap;
      return;
    }

    // Legacy fallback
    host.disableRenderTrigger = state.disableRenderTrigger;
    host.feedbackConfigs = state.feedbackConfigs;
    host.showFeedbackForOption = state.showFeedbackForOption;
    host.lastFeedbackOptionId = state.lastFeedbackOptionId;
    host.lastFeedbackQuestionIndex = state.lastFeedbackQuestionIndex;
    host.lastClickedOptionId = state.lastClickedOptionId;
    host.lastClickTimestamp = state.lastClickTimestamp;
    host.hasUserClicked.set(state.hasUserClicked);
    host.freezeOptionBindings.set(state.freezeOptionBindings);
    host.showFeedback.set(state.showFeedback);

    host.disabledOptionsPerQuestion = state.disabledOptionsPerQuestion;
    host.correctClicksPerQuestion = state.correctClicksPerQuestion;
    host.selectedOptionHistory = state.selectedOptionHistory;
    host.selectedOptionMap = state.selectedOptionMap;
  }
}