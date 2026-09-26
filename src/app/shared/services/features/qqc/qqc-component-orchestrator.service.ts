import { inject, Service } from '@angular/core';

import { Option, QuizQuestion, SelectedOption } from '@shared/models';

import { QqcOrchClickService } from './qqc-orch-click.service';
import { QqcOrchDisplayService } from './qqc-orch-display.service';
import { QqcOrchExplanationService } from './qqc-orch-explanation.service';
import { QqcOrchLifecycleService } from './qqc-orch-lifecycle.service';
import { QqcOrchQuestionLoadService } from './qqc-orch-question-load.service';
import { QqcOrchResetService } from './qqc-orch-reset.service';
import { QqcOrchSelectionService } from './qqc-orch-selection.service';
import { QqcOrchTimerService } from './qqc-orch-timer.service';

import type { QuizQuestionComponent } from '../../../../components/question/quiz-question/quiz-question.component';

type Host = QuizQuestionComponent;

/**
 * Orchestrates QuizQuestionComponent lifecycle/event method bodies.
 * Pure delegation facade — all logic lives in the 8 extracted sub-services.
 */
@Service()
export class QqcComponentOrchestratorService {
  // ── injects ─────────────────────────────────────────────────────
  private readonly orchClick = inject(QqcOrchClickService);
  private readonly orchDisplay = inject(QqcOrchDisplayService);
  private readonly orchExplanation = inject(QqcOrchExplanationService);
  private readonly orchLifecycle = inject(QqcOrchLifecycleService);
  private readonly orchQuestionLoad = inject(QqcOrchQuestionLoadService);
  private readonly orchReset = inject(QqcOrchResetService);
  private readonly orchSelection = inject(QqcOrchSelectionService);
  private readonly orchTimer = inject(QqcOrchTimerService);

  // ─── Lifecycle ───

  async runOnInit(host: Host): Promise<void> {
    return this.orchLifecycle.runOnInit(host);
  }

  async runAfterViewInit(host: Host): Promise<void> {
    return this.orchLifecycle.runAfterViewInit(host);
  }

  runOnDestroy(host: Host): void {
    this.orchLifecycle.runOnDestroy(host);
  }

  // ─── Click ───

  async runOnOptionClicked(
    host: Host,
    event: { option: any; index: number; checked: boolean; wasReselected?: boolean }
  ): Promise<void> {
    return this.orchClick.runOnOptionClicked(host, event);
  }

  // ─── Question Load ───

  async runLoadDynamicComponent(host: Host, question: QuizQuestion, options: Option[]): Promise<void> {
    return this.orchQuestionLoad.runLoadDynamicComponent(host, question, options);
  }

  async runLoadQuestion(host: Host, signal?: AbortSignal): Promise<boolean> {
    return this.orchQuestionLoad.runLoadQuestion(host, signal);
  }

  runSetupRouteChangeHandler(host: Host): void {
    this.orchQuestionLoad.runSetupRouteChangeHandler(host);
  }

  async runInitializeQuiz(host: Host): Promise<void> {
    return this.orchQuestionLoad.runInitializeQuiz(host);
  }

  async runInitializeQuizDataAndRouting(host: Host): Promise<void> {
    return this.orchQuestionLoad.runInitializeQuizDataAndRouting(host);
  }

  // ─── Timer ───

  runOnQuestionTimedOut(host: Host, targetIndex?: number): void {
    this.orchTimer.runOnQuestionTimedOut(host, targetIndex);
  }

  runHandleTimerStoppedForActiveQuestion(host: Host, reason: 'timeout' | 'stopped'): void {
    this.orchTimer.runHandleTimerStoppedForActiveQuestion(host, reason);
  }

  async runOnTimerExpiredFor(host: Host, index: number): Promise<void> {
    return this.orchTimer.runOnTimerExpiredFor(host, index);
  }

  // ─── Explanation ───

  async runOnVisibilityChange(host: Host): Promise<void> {
    return this.orchExplanation.runOnVisibilityChange(host);
  }

  async runUpdateExplanationDisplay(host: Host, shouldDisplay: boolean): Promise<void> {
    return this.orchExplanation.runUpdateExplanationDisplay(host, shouldDisplay);
  }

  async runFetchAndSetExplanationText(host: Host, questionIndex: number): Promise<void> {
    return this.orchExplanation.runFetchAndSetExplanationText(host, questionIndex);
  }

  runUpdateExplanationUI(host: Host, questionIndex: number, explanationText: string): void {
    this.orchExplanation.runUpdateExplanationUI(host, questionIndex, explanationText);
  }

  async runUpdateExplanationIfAnswered(host: Host, index: number, question: QuizQuestion): Promise<void> {
    return this.orchExplanation.runUpdateExplanationIfAnswered(host, index, question);
  }

  runHandlePageVisibilityChange(host: Host, isHidden: boolean): void {
    this.orchExplanation.runHandlePageVisibilityChange(host, isHidden);
  }

  runApplyExplanationTextInZone(host: Host, text: string): void {
    this.orchExplanation.runApplyExplanationTextInZone(host, text);
  }

  runApplyExplanationFlags(host: Host, flags: any): void {
    this.orchExplanation.runApplyExplanationFlags(host, flags);
  }

  runResetExplanation(host: Host, force = false): void {
    this.orchExplanation.runResetExplanation(host, force);
  }

  async runPrepareAndSetExplanationText(host: Host, questionIndex: number): Promise<string> {
    return this.orchExplanation.runPrepareAndSetExplanationText(host, questionIndex);
  }

  async runUpdateExplanationText(host: Host, index: number): Promise<string> {
    return this.orchExplanation.runUpdateExplanationText(host, index);
  }

  // ─── Selection ───

  async runHandleOptionSelection(
    host: Host,
    option: SelectedOption,
    optionIndex: number,
    currentQuestion: QuizQuestion
  ): Promise<void> {
    return this.orchSelection.runHandleOptionSelection(host, option, optionIndex, currentQuestion);
  }

  async runIsAnyOptionSelected(host: Host, questionIndex: number): Promise<boolean> {
    return this.orchSelection.runIsAnyOptionSelected(host, questionIndex);
  }

  async runOnSubmitMultiple(host: Host): Promise<void> {
    return this.orchSelection.runOnSubmitMultiple(host);
  }

  async runPostClickTasks(
    host: Host,
    opt: SelectedOption,
    idx: number,
    checked: boolean,
    wasPreviouslySelected: boolean,
    questionIndex?: number
  ): Promise<void> {
    return this.orchSelection.runPostClickTasks(host, opt, idx, checked, wasPreviouslySelected, questionIndex);
  }

  async runPerformInitialSelectionFlow(host: Host, event: any, option: SelectedOption): Promise<void> {
    return this.orchSelection.runPerformInitialSelectionFlow(host, event, option);
  }

  async runApplyFeedbackIfNeeded(host: Host, option: SelectedOption): Promise<void> {
    return this.orchSelection.runApplyFeedbackIfNeeded(host, option);
  }

  async runApplyOptionFeedback(host: Host, selectedOption: Option): Promise<void> {
    return this.orchSelection.runApplyOptionFeedback(host, selectedOption);
  }

  async runFinalizeSelection(
    host: Host,
    option: SelectedOption,
    index: number,
    wasPreviouslySelected: boolean
  ): Promise<void> {
    return this.orchSelection.runFinalizeSelection(host, option, index, wasPreviouslySelected);
  }

  async runFetchAndProcessCurrentQuestion(host: Host): Promise<QuizQuestion | null> {
    return this.orchSelection.runFetchAndProcessCurrentQuestion(host);
  }

  async runSelectOption(
    host: Host,
    currentQuestion: QuizQuestion,
    option: SelectedOption,
    optionIndex: number
  ): Promise<void> {
    return this.orchSelection.runSelectOption(host, currentQuestion, option, optionIndex);
  }

  runUnselectOption(host: Host): void {
    this.orchSelection.runUnselectOption(host);
  }

  async runOnSubmit(host: Host): Promise<void> {
    return this.orchSelection.runOnSubmit(host);
  }

  runEmitPassiveNow(host: Host, index: number): void {
    this.orchSelection.runEmitPassiveNow(host, index);
  }

  // ─── Reset ───

  async runResetQuestionStateBeforeNavigation(
    host: Host,
    options?: { preserveVisualState?: boolean; preserveExplanation?: boolean }
  ): Promise<void> {
    return this.orchReset.runResetQuestionStateBeforeNavigation(host, options);
  }

  runResetPerQuestionState(host: Host, index: number): void {
    this.orchReset.runResetPerQuestionState(host, index);
  }

  runResetState(host: Host): void {
    this.orchReset.runResetState(host);
  }

  runResetFeedback(host: Host): void {
    this.orchReset.runResetFeedback(host);
  }

  runResetForQuestion(host: Host, index: number): void {
    this.orchReset.runResetForQuestion(host, index);
  }

  // ─── Display ───

  runUpdateOptionsSafely(host: Host, newOptions: Option[]): void {
    this.orchDisplay.runUpdateOptionsSafely(host, newOptions);
  }

  runHydrateFromPayload(host: Host, payload: any): void {
    this.orchDisplay.runHydrateFromPayload(host, payload);
  }

  runSetQuestionOptions(host: Host): void {
    this.orchDisplay.runSetQuestionOptions(host);
  }

  runUpdateOptionHighlighting(host: Host, selectedKeys: Set<string | number>): void {
    this.orchDisplay.runUpdateOptionHighlighting(host, selectedKeys);
  }

  runRefreshFeedbackFor(host: Host, opt: Option): void {
    this.orchDisplay.runRefreshFeedbackFor(host, opt);
  }

  runPopulateOptionsToDisplay(host: Host): Option[] {
    return this.orchDisplay.runPopulateOptionsToDisplay(host);
  }

  runInitializeForm(host: Host): void {
    this.orchDisplay.runInitializeForm(host);
  }

  async runResolveFormatted(host: Host, index: number, opts: { useCache?: boolean; setCache?: boolean; timeoutMs?: number } = {}): Promise<string> {
    return this.orchDisplay.runResolveFormatted(host, index, opts);
  }

  runDisableAllBindingsAndOptions(host: Host): { optionBindings: any[]; optionsToDisplay: Option[] } {
    return this.orchDisplay.runDisableAllBindingsAndOptions(host);
  }

  runRevealFeedbackForAllOptions(host: Host, canonicalOpts: Option[]): void {
    this.orchDisplay.runRevealFeedbackForAllOptions(host, canonicalOpts);
  }

  runUpdateShouldRenderOptions(host: Host, options: Option[] | null | undefined): void {
    this.orchDisplay.runUpdateShouldRenderOptions(host, options);
  }

  runSafeSetDisplayState(host: Host, state: { mode: 'question' | 'explanation'; answered: boolean }): void {
    this.orchDisplay.runSafeSetDisplayState(host, state);
  }
}