import {
  AfterViewInit, ChangeDetectionStrategy, ChangeDetectorRef, Component, computed, DestroyRef,
  DoCheck, inject, input, OnInit, output, signal
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatCheckboxModule, MatCheckboxChange } from '@angular/material/checkbox';
import { MatRadioModule, MatRadioChange } from '@angular/material/radio';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Observable } from 'rxjs';

import { FeedbackProps } from '../../../../shared/models/FeedbackProps.model';
import { Option } from '../../../../shared/models/Option.model';
import { OptionBindings } from '../../../../shared/models/OptionBindings.model';
import { OptionClickedPayload } from '../../../../shared/models/OptionClickedPayload.model';
import { QuizQuestion } from '../../../../shared/models/QuizQuestion.model';
import { SelectedOption } from '../../../../shared/models/SelectedOption.model';
import { SharedOptionConfig } from '../../../../shared/models/SharedOptionConfig.model';

import { OptionClickHandlerService } from '../../../../shared/services/options/engine/option-click-handler.service';
import { OptionFeedbackDisplayService } from '../../../../shared/services/features/shared-option/option-feedback-display.service';
import { OptionFeedbackEffectsService } from '../../../../shared/services/features/shared-option/option-feedback-effects.service';
import { OptionInteractionEffectsService } from '../../../../shared/services/features/shared-option/option-interaction-effects.service';
import { OptionLockService } from '../../../../shared/services/options/policy/option-lock.service';
import { OptionSelectionUiService } from '../../../../shared/services/options/engine/option-selection-ui.service';
import { OptionService } from '../../../../shared/services/options/view/option.service';
import { OptionUiContextBuilderService } from '../../../../shared/services/options/engine/option-ui-context-builder.service';
import { OptionUiSyncContext } from '../../../../shared/services/options/engine/option-ui-sync.service';
import { OptionUiSyncEffectsService } from '../../../../shared/services/features/shared-option/option-ui-sync-effects.service';
import { QuestionResolutionService } from '../../../../shared/services/options/engine/question-resolution.service';
import { pinAllOfTheAboveLast } from '../../../../shared/utils/all-of-the-above';
import { QuizService } from '../../../../shared/services/data/quiz.service';
import { SelectedOptionService } from '../../../../shared/services/state/selectedoption.service';
import { SharedOptionBindingService } from '../../../../shared/services/options/engine/shared-option-binding.service';
import { SharedOptionClickService } from '../../../../shared/services/options/engine/shared-option-click.service';
import { SharedOptionExplanationService } from '../../../../shared/services/features/shared-option/shared-option-explanation.service';
import { SharedOptionFeedbackService, FeedbackContext } from '../../../../shared/services/features/shared-option/shared-option-feedback.service';
import { SharedOptionInitService } from '../../../../shared/services/options/engine/shared-option-init.service';
import { SharedOptionOrchestratorService } from '../../../../shared/services/features/shared-option/shared-option-orchestrator.service';
import { SharedOptionStateAdapterService, SharedOptionUiState } from '../../../../shared/services/state/shared-option-state-adapter.service';
import { SoundService } from '../../../../shared/services/ui/sound.service';
import { TimerService } from '../../../../shared/services/features/timer/timer.service';


import { FeedbackComponent } from '../feedback/feedback.component';
import { OptionItemComponent } from './option-item/option-item.component';
import type { OptionUIEvent } from './option-item/option-item.component';

import { correctAnswerAnim } from '../../../../animations/animations';
import { SharedOptionConfigDirective } from '../../../../directives/shared-option-config.directive';

@Component({
  selector: 'app-shared-option',
  standalone: true,
  imports: [
    NgTemplateOutlet,
    ReactiveFormsModule,
    MatIconModule,
    MatRadioModule,
    MatCheckboxModule,
    SharedOptionConfigDirective,
    FeedbackComponent,
    OptionItemComponent
  ],
  templateUrl: './shared-option.component.html',
  styleUrls: [
    '../../quiz-question/quiz-question.component.scss',
    './shared-option.component.scss'
  ],
  animations: [correctAnswerAnim],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(window:visibilitychange)': 'onVisibilityChange()'
  }
})
export class SharedOptionComponent
    implements OnInit, DoCheck, AfterViewInit {
  // ── injects ─────────────────────────────────────────────────────
  private readonly bindingService = inject(SharedOptionBindingService);
  public readonly clickHandler = inject(OptionClickHandlerService);
  public readonly clickService = inject(SharedOptionClickService);
  public readonly explanationHandler = inject(SharedOptionExplanationService);
  public readonly feedbackManager = inject(SharedOptionFeedbackService);
  private readonly initService = inject(SharedOptionInitService);
  private readonly optionFeedbackDisplay = inject(OptionFeedbackDisplayService);
  private readonly optionFeedbackEffects = inject(OptionFeedbackEffectsService);
  private readonly optionInteractionEffects = inject(OptionInteractionEffectsService);
  private readonly optionLockService = inject(OptionLockService);
  public readonly optionSelectionUiService = inject(OptionSelectionUiService);
  public readonly optionService = inject(OptionService);
  private readonly optionUiContextBuilder = inject(OptionUiContextBuilderService);
  private readonly optionUiSyncEffects = inject(OptionUiSyncEffectsService);
  private readonly orchestrator = inject(SharedOptionOrchestratorService);
  private readonly questionResolution = inject(QuestionResolutionService);
  public readonly quizService = inject(QuizService);
  private readonly selectedOptionService = inject(SelectedOptionService);
  private readonly sharedOptionStateAdapterService = inject(SharedOptionStateAdapterService);
  public readonly soundService = inject(SoundService);
  private readonly timerService = inject(TimerService);
  public readonly cdRef = inject(ChangeDetectorRef);
  public readonly destroyRef = inject(DestroyRef);
  private readonly fb = inject(FormBuilder);

  // ── outputs ─────────────────────────────────────────────────────
  readonly optionClicked = output<OptionClickedPayload>();
  readonly optionEvent = output<OptionUIEvent>();
  readonly reselectionDetected = output<boolean>();
  readonly explanationUpdate = output<number>();
  readonly renderReadyChange = output<boolean>();
  readonly showExplanationChange = output<boolean>();
  readonly explanationToDisplayChange = output<string>();

  // ── inputs ──────────────────────────────────────────────────────
  // Signal inputs (parent-bound). Internal mutable backing fields with the same
  // logical names are kept below, since multiple services write to them via
  // `host as any`. Effects in the constructor mirror input → backing field.
  readonly currentQuestionInput = input<QuizQuestion | null>(null);
  readonly currentQuestionIndexInput = input<number | undefined>(undefined);
  readonly questionIndex = input<number | null>(null);
  readonly optionsToDisplayInput = input<Option[] | undefined>(undefined);
  readonly quizId = input<string | undefined>(undefined);
  readonly typeInput = input<'single' | 'multiple'>('single');
  readonly config = input<SharedOptionConfig | undefined>(undefined);
  readonly highlightCorrectAfterIncorrect = input<boolean>(false);
  readonly quizQuestionComponentOnOptionClicked = input<((option: SelectedOption, index: number) => void) | undefined>(undefined);
  readonly optionBindingsInput = input<OptionBindings[]>([]);
  readonly selectedOptionId = input<number | null>(null);
  readonly isNavigatingBackwardsInput = input<boolean>(false);
  readonly renderReadyInput = input<boolean>(false);
  readonly finalRenderReady$ = input<Observable<boolean> | null>(null);
  readonly questionVersion = input<number>(0);  // increments every time questionIndex changes

  // ── remaining variables ─────────────────────────────────────────
  // Mutable backing fields (mirrored from inputs and freely written by services)
  readonly currentQuestion = signal<QuizQuestion | null>(null);
  public currentQuestionIndex!: number;
  public optionsToDisplay!: Option[];
  public type: 'single' | 'multiple' = 'single';
  readonly selectedOption = signal<Option | null>(null);
  public showFeedbackForOption!: { [key: string | number]: boolean };
  readonly correctMessage = signal<string>('');
  readonly showFeedback = signal<boolean>(false);
  readonly shouldResetBackground = signal<boolean>(false);
  readonly optionBindings = signal<OptionBindings[]>([]);
  // Render-layer view of the bindings with any "All of the above" option pinned
  // LAST. This is the single render chokepoint (the template iterates this),
  // downstream of every option setter, so the displayed order is always
  // AOTA-last regardless of which setter won — and idempotent, so it can't churn.
  readonly displayedBindings = computed<OptionBindings[]>(() =>
    pinAllOfTheAboveLast(this.optionBindings() ?? [], (b) => b?.option?.text)
  );
  readonly selectedOptionIndex = signal<number | null>(null);
  readonly isNavigatingBackwards = signal<boolean>(false);
  public selectedOptionMap = new Map<number | string, boolean>();
  public perQuestionHistory = new Set<number | string>();
  public ui!: SharedOptionUiState;
  readonly isSelected = signal<boolean>(false);
  feedbackBindings: FeedbackProps[] = [];
  currentFeedbackConfig!: FeedbackProps;
  feedbackConfigs: { [key: string]: FeedbackProps } = {};
  readonly activeFeedbackConfig = signal<FeedbackProps | null>(null);
  // Simple, bulletproof feedback tracker: set synchronously at the end of runOptionContentClick.
  // Bypasses complex service pipeline; cleared on question change.
  // Must be public for template access.
  public _feedbackDisplay: { idx: number; optionId?: number | null; config: FeedbackProps } | null = null;
  selectedOptions: Set<number | string> = new Set();
  clickedOptionIds: Set<number | string> = new Set();
  selectedOptionHistory: (number | string)[] = [];
  // Track CORRECT option clicks per question for timer stop logic
  public correctClicksPerQuestion: Map<number, Set<number>> = new Map();
  // Track DISABLED option IDs per question - persists across binding recreations
  public disabledOptionsPerQuestion: Map<number, Set<number>> = new Map();
  lastFeedbackQuestionIndex = -1;
  lastFeedbackOptionId: number | string = -1;
  lastSelectedOptionId: number | string = -1;
  lastClickedOptionId: number | string | null = null;
  lastClickTimestamp: number | null = null;
  readonly hasUserClicked = signal<boolean>(false);
  readonly freezeOptionBindings = signal<boolean>(false);
  highlightedOptionIds: Set<number | string> = new Set();

  // Counter to force OnPush re-render when disabled state changes
  disableRenderTrigger = 0;

  readonly showOptions = signal<boolean>(false);
  form!: FormGroup;

  readonly renderReady = signal(false);

  // Include disableRenderTrigger to force re-render when disabled state changes
  trackByOptionId = (b: OptionBindings, idx: number) => {
    const idPart = (b.option?.optionId != null && b.option.optionId !== -1) ? b.option.optionId : `idx-${idx}`;
    const questionPart = this.getActiveQuestionIndex();
    return `q${questionPart}_${idPart}_${idx}`;
  };

  public flashDisabledSet = new Set<number>();
  lockedIncorrectOptionIds = new Set<number>();
  readonly forceDisableAll = signal<boolean>(false);
  readonly timerExpiredForQuestion = signal<boolean>(false);  // track timer expiration
  timeoutCorrectOptionKeys = new Set<string>();
  resolvedQuestionIndex: number | null = null;

  _isMultiModeCache: boolean | null = null;
  public _lastHandledIndex: number | null = null;
  public _lastHandledTime: number | null = null;

  // BULLETPROOF feedback tracker: set synchronously in handleOptionClick,
  // NEVER cleared by generateOptionBindings/rebuild cycles.
  // Only cleared on question change.
  public _lastClickFeedback: { index: number; config: FeedbackProps; questionIdx: number } | null = null;

  // DURABLE multi-answer selection tracker. Survives binding regeneration.
  // Maps question index → Set of selected display indices.
  // Only cleared on question change (resetStateForNewQuestion).
  _multiSelectByQuestion = new Map<number, Set<number>>();
  _correctIndicesByQuestion = new Map<number, number[]>();

  // Flag to prevent the timer-expiry effect from firing more than once per question
  public _timerExpiryHandled = false;

  // Runtime-mutated state used by the orchestrator service. Declared here so
  // the Host type (SharedOptionComponent) sees them; values default to falsy
  // until the orchestrator writes on init.
  readonly viewReady = signal<boolean>(false);
  lastProcessedQuestionIndex = -1;
  readonly optionBindingsInitialized = signal<boolean>(false);

  _pendingHighlightRAF: number | null = null;

  public _lastRunClickIndex: number | null = null;
  public _lastRunClickTime: number | null = null;

  // ── constructor ─────────────────────────────────────────────────
  constructor() {
    this.ui = this.sharedOptionStateAdapterService.createInitialUiState();
    this.form = this.fb.group({
      selectedOptionId: [null, Validators.required]
    });

    // Mirror signal inputs into mutable backing fields. Services elsewhere
    // freely reassign these fields via `host as any`, so we cannot expose
    // the readonly signals directly under those names. The UI-sync effects
    // are owned by OptionUiSyncEffectsService; registered here in two parts so
    // the interaction (Q→Q cleanup) effect below keeps its exact creation
    // position (effect order is load-bearing — see the service docs).
    this.optionUiSyncEffects.registerCurrentQuestionMirror(this);
    // Effect #2 (Q→Q transition cleanup), owned by OptionInteractionEffectsService.
    // Registered at its original position so creation order is preserved.
    this.optionInteractionEffects.registerQuestionTransitionCleanup(this);
    // Effects #3–#9 (input mirrors + render-sync watchdogs), owned by
    // OptionUiSyncEffectsService. Registered here — immediately after the
    // interaction cleanup effect above — to preserve the original creation order.
    this.optionUiSyncEffects.registerInputAndRenderSync(this);

    // Effects #10–#11 (multi-answer auto-disable + timer-expiry watcher),
    // owned by OptionFeedbackEffectsService. Registered LAST so overall
    // effect-creation order is preserved.
    this.optionFeedbackEffects.registerFeedbackEffects(this);

    this.destroyRef.onDestroy(() => {
      this.orchestrator.runOnDestroy(this);
    });
  }

  // ── lifecycle hooks ─────────────────────────────────────────────
  ngOnInit(): void {
    this.orchestrator.runOnInit(this);
  }

  ngAfterViewInit(): void {
    this.orchestrator.runAfterViewInit(this);
  }

  ngDoCheck(): void {
    this.updateBindingSnapshots();
    this.syncUiSelectedTexts();
  }

  // Publish the current question's selected option texts (from live bindings
  // UNION the first-visit revisit snapshot) to SelectedOptionService, so the
  // multi-answer completion lock in option-item reads a reliable, reactive,
  // auto-reveal-invisible source instead of the flaky selectedOptionsMap. The
  // snapshot union is what lets "complete a partial multi-answer on revisit"
  // register as all-correct even though the bindings were reset on revisit.
  private syncUiSelectedTexts(): void {
    try {
      const qIdx = this.getActiveQuestionIndex();
      if (qIdx == null || qIdx < 0) return;
      const texts: string[] = [];
      for (const b of this.optionBindings() ?? []) {
        const opt = b?.option;
        if (!opt?.text) continue;

        // AUTO-REVEAL IS DISPLAY, NOT AN ANSWER.
        //
        // When every incorrect option has been picked, auto-reveal paints the
        // correct ones — `highlight`/`showIcon`/`active` — but deliberately
        // leaves `selected`/`isSelected` set only for the option the user
        // actually clicked (applyAutoRevealBindings). Reading `highlight` as
        // selection therefore turned a reveal into an answer: this set is
        // submitted to POST /check, so the app was telling the server the user
        // had selected options it had revealed to them, and the server —
        // correctly — called the question resolved.
        //
        // `highlight` still counts for everything else, because a
        // previously-clicked option keeps it after the bindings are rebuilt.
        const revealed =
          (b as any)?._autoRevealedCorrect === true ||
          (opt as any)?._autoRevealedCorrect === true;
        const userSelected =
          b.isSelected === true || opt.selected === true || (!revealed && opt.highlight === true);

        if (userSelected) texts.push(opt.text);
      }
      const snapshot = this.selectedOptionService.getRevisitDisplayTexts(qIdx);
      if (snapshot) texts.push(...snapshot);
      this.selectedOptionService.setUiSelectedTextsForQuestion(qIdx, texts);
    } catch { /* non-fatal — lock falls back to selectedOptionsMap */ }
  }

  // ── methods (host-pattern delegators + template helpers) ─────────
  get isMultiMode(): boolean {
    return this.orchestrator.runIsMultiMode(this);
  }

  onVisibilityChange(): void {
    this.orchestrator.runOnVisibilityChange(this);
  }

  initializeQuestionIndex(): void {
    this.orchestrator.runInitializeQuestionIndex(this);
  }

  resetStateForNewQuestion(): void {
    this.initService.resetStateForNewQuestion(this as any);
  }

  subscribeToTimerExpiration(): void {
    this.initService.subscribeToTimerExpiration(this as any);
  }

  setupFallbackRendering(): void {
    this.initService.setupFallbackRendering(this as any);
  }

  initializeConfiguration(): void {
    this.initService.initializeConfiguration(this as any);
  }

  initializeOptionDisplayWithFeedback(): void {
    this.initService.initializeOptionDisplayWithFeedback(this as any);
  }

  setupSubscriptions(): void {
    this.initService.setupSubscriptions(this as any);
  }

  subscribeToSelectionChanges(): void {
    this.initService.subscribeToSelectionChanges(this as any);
  }

  public rehydrateUiFromState(reason: string): void {
    this.bindingService.rehydrateUiFromState(this, reason);
  }

  setupRehydrateTriggers(): void {
    this.initService.setupRehydrateTriggers(this as any);
  }

  rebuildShowFeedbackMapFromBindings(): void {
    this.orchestrator.runRebuildShowFeedbackMapFromBindings(this);
  }

  public updateSelections(rawSelectedId: number | string): void {
    this.orchestrator.runUpdateSelections(this, rawSelectedId);
  }

  ensureOptionsToDisplay(): void {
    this.clickService.ensureOptionsToDisplay(this);
  }

  public synchronizeOptionBindings(): void {
    this.bindingService.synchronizeOptionBindings(this);
  }

  buildSharedOptionConfig(b: OptionBindings, i: number): SharedOptionConfig {
    return this.bindingService.buildSharedOptionConfig(this, b, i);
  }

  preserveOptionHighlighting(): void {
    this.clickService.preserveOptionHighlighting(this);
  }

  initializeFromConfig(): void {
    this.initService.initializeFromConfig(this as any);
  }

  public setOptionBindingsIfChanged(newOptions: Option[]): void {
    this.bindingService.setOptionBindingsIfChanged(this, newOptions);
  }

  getOptionDisplayText(option: Option, idx: number): string {
    return this.optionService.getOptionDisplayText(option, idx);
  }

  public getOptionIcon(binding: OptionBindings, i: number): string {
    return this.optionService.getOptionIcon(binding, i);
  }

  public getOptionClasses(binding: OptionBindings): { [key: string]: boolean } {
    return this.orchestrator.runGetOptionClasses(this, binding);
  }

  // Returns cursor style for option - 'not-allowed' for disabled/incorrect
  // options or when timer expired
  public getOptionCursor(binding: OptionBindings, index: number): string {
    return this.optionService.getOptionCursor(
      binding, index, this.isDisabled(binding, index), this.timerExpiredForQuestion()
    );
  }

  // Decide if an option should be disabled, only checks disabledOptionsPerQuestion
  // Map. All actual disabling decisions are made in onOptionContentClick
  public shouldDisableOption(binding: OptionBindings): boolean {
    return this.orchestrator.runShouldDisableOption(this, binding);
  }

  public computeDisabledState(option: Option, index: number): boolean {
    return this.orchestrator.runComputeDisabledState(this, option, index);
  }

  // Wrapper for template compatibility or legacy calls
  public isDisabled(binding: OptionBindings, index: number): boolean {
    // Return the pre-computed state from the binding snapshot if available/trusted,
    // otherwise re-compute for robust click guarding.
    return this.computeDisabledState(binding.option, index);
  }

  public onOptionInteraction(binding: OptionBindings, index: number, event: MouseEvent): void {
    this.orchestrator.runOnOptionInteraction(this, binding, index, event);
  }

  public onOptionChanged(
      binding: OptionBindings,
      index: number,
      event: MatCheckboxChange | MatRadioChange
  ): void {
    this.updateOptionAndUI(binding, index, event);
  }

  public updateOptionAndUI(
      optionBinding: OptionBindings,
      index: number,
      event: MatCheckboxChange | MatRadioChange,
      existingCtx?: OptionUiSyncContext
  ): void {
    this.clickService.updateOptionAndUI(this, optionBinding, index, event, existingCtx);
  }

  public resolveInteractionType(): 'single' | 'multiple' {
    return this.isMultiMode ? 'multiple' : 'single';
  }

  buildFeedbackContext(): FeedbackContext {
    return this.orchestrator.runBuildFeedbackContext(this);
  }

  public buildOptionUiSyncContext(): OptionUiSyncContext {
    return this.optionUiContextBuilder.fromSharedOptionComponent(this);
  }

  public emitExplanation(questionIndex: number, skipGuard = false): void {
    this.orchestrator.runEmitExplanation(this, questionIndex, skipGuard);
  }

  public resolveDisplayIndex(questionIndex: number): number {
    return this.explanationHandler.resolveDisplayIndex(
        questionIndex,
        () => this.getActiveQuestionIndex(),
        this.currentQuestionIndex,
        this.resolvedQuestionIndex
    );
  }

  public deferHighlightUpdate(callback: () => void): void {
    this.orchestrator.runDeferHighlightUpdate(this, callback);
  }


  public async handleOptionClick(
      option: SelectedOption | undefined,
      index: number
  ): Promise<void> {
    if (!option) return;

    // Redirect to the unified UI flow which handles synchronization and services
    this.onOptionUI({
      optionId: option.optionId ?? -1,
      displayIndex: index,
      kind: 'interaction',
      inputType: this.isMultiMode ? 'checkbox' : 'radio',
      nativeEvent: new MouseEvent('click')
    });
  }

  displayFeedbackForOption(
    option: SelectedOption,
    index: number,
    optionId: number
  ): void {
    this.orchestrator.runDisplayFeedbackForOption(this, option, index, optionId);
  }

  generateFeedbackConfig(
    option: SelectedOption,
    selectedIndex: number
  ): FeedbackProps {
    return this.feedbackManager.generateFeedbackConfig(option, selectedIndex, this.buildFeedbackContext());
  }

  handleBackwardNavigationOptionClick(option: Option, index: number): void {
    this.clickService.handleBackwardNavigationOptionClick(this, option, index);
  }

  public resetUIForNewQuestion(): void {
    this.orchestrator.runResetUIForNewQuestion(this);
  }

  getOptionBindings(option: Option, idx: number, isSelected: boolean = false): OptionBindings {
    return this.bindingService.getOptionBindings(this, option, idx, isSelected);
  }

  public generateOptionBindings(): void {
    this.bindingService.generateOptionBindings(this);
  }

  public hydrateOptionsFromSelectionState(): void {
    this.bindingService.hydrateOptionsFromSelectionState(this);
  }

  getFeedbackBindings(option: Option, idx: number): FeedbackProps {
    return this.feedbackManager.getFeedbackBindings(option, idx, this.buildFeedbackContext());
  }

  initializeOptionBindings(): void {
    this.orchestrator.runInitializeOptionBindings(this);
  }

  initializeFeedbackBindings(): void {
    this.feedbackBindings = this.feedbackManager.initializeFeedbackBindings(
      this.optionBindings(), this.buildFeedbackContext()
    );
  }

  isSelectedOption(option: Option): boolean {
    return this.selectedOptionId() === option.optionId;
  }

  ensureOptionIds(): void {
    this.orchestrator.runEnsureOptionIds(this);
  }

  public shouldShowIcon(option: Option, i: number): boolean {
    return this.orchestrator.runShouldShowIcon(this, option, i);
  }

  shouldShowFeedbackFor(b: OptionBindings): boolean {
    return this.optionFeedbackDisplay.shouldShowFeedbackFor(this, b);
  }

  public canDisplayOptions(): boolean {
    return this.orchestrator.runCanDisplayOptions(this);
  }

  public markRenderReady(reason: string = ''): void {
    this.orchestrator.runMarkRenderReady(this, reason);
  }

  public regenerateFeedback(idx: number): void {
    this.orchestrator.runRegenerateFeedback(this, idx);
  }

  // Determine relative component logic for Q-type
  determineQuestionType(input: QuizQuestion): 'single' | 'multiple' {
    return this.clickHandler.determineQuestionType(input);
  }

  public finalizeOptionPopulation(): void {
    this.orchestrator.runFinalizeOptionPopulation(this);
  }

  public forceDisableAllOptions(): void {
    this.bindingService.forceDisableAllOptions(this);
  }

  public clearForceDisableAllOptions(): void {
    this.bindingService.clearForceDisableAllOptions(this);
  }

  public applySelectionsUI(selectedOptions: SelectedOption[]): void {
    this.clickService.applySelectionsUI(this, selectedOptions);
  }

  isLocked(b: OptionBindings, i: number): boolean {
    return this.optionLockService.isLocked(b, i, this.resolveCurrentQuestionIndex());
  }

  // Single place to decide disabled


  // Use the same key shape everywhere (STRING so we don't lose non-numeric ids)
  // Stable per-row key: prefer numeric optionId; fallback to stableKey + index
  public keyOf(o: Option, i: number): string {
    return this.optionService.keyOf(o, i);
  }

  // Feedback config for a rendered binding, resolved by optionId (identity)
  // first so it survives the render-layer AOTA pin (display index differs from
  // canonical index), falling back to the positional keyOf key.
  public feedbackConfigFor(b: OptionBindings, i: number): FeedbackProps {
    const id = b.option?.optionId;
    const byId = (id != null) ? this.feedbackConfigs[id] : undefined;
    return byId ?? this.feedbackConfigs[this.keyOf(b.option, i)];
  }

  public shouldShowFeedbackAfter(b: OptionBindings, i: number): boolean {
    return this.optionFeedbackDisplay.shouldShowFeedbackAfter(this, b, i);
  }

  public getInlineFeedbackConfig(b: OptionBindings, i: number): FeedbackProps | null {
    return this.optionFeedbackDisplay.getInlineFeedbackConfig(this, b, i);
  }

  public resolveCurrentQuestionIndex(): number {
    return this.orchestrator.runResolveCurrentQuestionIndex(this);
  }

  getQuestionAtDisplayIndex(displayIndex: number): QuizQuestion | null {
    return this.orchestrator.runGetQuestionAtDisplayIndex(this, displayIndex);
  }

  canShowOptions(): boolean {
    return this.orchestrator.runCanShowOptions(this);
  }

  normalizeQuestionIndex(candidate: unknown): number | null {
    return this.orchestrator.runNormalizeQuestionIndex(this, candidate);
  }

  updateResolvedQuestionIndex(candidate: unknown): void {
    this.orchestrator.runUpdateResolvedQuestionIndex(this, candidate);
  }

  public getActiveQuestionIndex(): number {
    return this.orchestrator.runGetActiveQuestionIndex(this);
  }

  public onOptionUI(ev: OptionUIEvent): void {
    this.clickService.onOptionUI(this, ev);
  }

  public findBindingByOptionId(optionId: number): { b: OptionBindings; i: number } | null {
    return this.orchestrator.runFindBindingByOptionId(this, optionId);
  }

  runOptionContentClick(binding: OptionBindings, index: number, event: any): void {
    this.clickService.runOptionContentClick(this, binding, index, event);
  }

  public triggerViewRefresh(): void {
    this.cdRef.markForCheck();
  }

  private updateBindingSnapshots(): void {
    this.clickService.updateBindingSnapshots(this);
  }
}
