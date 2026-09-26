import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  model,
  OnInit,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { FormGroup, ReactiveFormsModule } from '@angular/forms';

import {
  Option,
  OptionBindings,
  OptionClickedPayload,
  QuizQuestion,
  SelectedOption,
  SharedOptionConfig
} from '@shared/models';

import { AnswerBindingsService } from '@shared/services/features/answer/answer-bindings.service';
import { AnswerOptionsService } from '@shared/services/features/answer/answer-options.service';
import { AnswerSelectionService } from '@shared/services/features/answer/answer-selection.service';

import { QqcQuestionLoaderService } from '@shared/services/features/qqc/qqc-question-loader.service';
import { QuizQuestionManagerService } from '@shared/services/flow/quizquestionmgr.service';
import { TopicQuizTypeRegistry } from '@shared/services/api/topic-quiz-type-registry.service';

import { SharedOptionComponent } from '../shared-option-component/shared-option.component';

import { BaseQuestion } from '../../base/base-question';

import { isOptionCorrect } from '@shared/utils/is-option-correct';
import { norm } from '@shared/utils/text-norm';

@Component({
  selector: 'codelab-question-answer',
  standalone: true,
  imports: [ReactiveFormsModule, SharedOptionComponent],
  templateUrl: './answer.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AnswerComponent extends BaseQuestion<OptionClickedPayload> implements OnInit {
  // ── injects ─────────────────────────────────────────────────────
  private readonly answerBindingsService = inject(AnswerBindingsService);
  private readonly typeRegistry = inject(TopicQuizTypeRegistry);
  private readonly answerOptionsService = inject(AnswerOptionsService);
  private readonly answerSelectionService = inject(AnswerSelectionService);
  protected readonly quizQuestionLoaderService = inject(QqcQuestionLoaderService);
  protected readonly quizQuestionManagerService = inject(QuizQuestionManagerService);

  // ── outputs ─────────────────────────────────────────────────────
  readonly componentLoaded = output<any>();
  readonly optionSelected = output<{
    option: SelectedOption;
    index: number;
    checked: boolean;
  }>();
  readonly quizQuestionComponentLoaded = output<void>();

  // ── inputs ──────────────────────────────────────────────────────
  readonly isNavigatingBackwards = input<boolean>(false);
  readonly quizId = input<string | undefined>(undefined);
  readonly form = input<FormGroup | undefined>(undefined);
  readonly questionIndex = input<number | null>(null);

  // ── models ──────────────────────────────────────────────────────
  readonly questionData = model<QuizQuestion | undefined>(undefined);
  readonly currentQuestionIndex = model<number | undefined>(undefined);

  // ── remaining variables ─────────────────────────────────────────
  readonly renderReady = signal(false);
  private readonly optionBindingsSource = signal<Option[]>([]);
  override showFeedbackForOption: { [optionId: number]: boolean } = {};
  override selectedOption: SelectedOption | null = null;
  selectedOptions: SelectedOption[] = [];
  readonly incomingOptions = signal<Option[]>([]);
  override sharedOptionConfig!: SharedOptionConfig;
  readonly hasComponentLoaded = signal(false);
  override selectedOptionIndex = -1;

  constructor() {
    super();

    // React to signal-input updates from the dynamic loader (replaces ngOnChanges)
    effect(() => {
      const q = this.questionData();
      if (q) {
        this.type.set(this.resolveQuestionType(q?.questionText, q.options ?? []));
      }
    });

    effect(() => {
      const next = this.optionsToDisplay();
      if (Array.isArray(next) && next.length) {
        // Skip rebuild if the option set is the same as the current bindings
        // (e.g. parent re-emit after a click). Rebuilding here would wipe
        // the highlight state we just set in onOptionClicked.
        const currentBindings = this.optionBindings();
        const sameSet =
          currentBindings?.length === next.length &&
          currentBindings.every((b, i) => {
            const a = b.option;
            const n = next[i];
            return !!a?.text && a.text === n?.text;
          });
        if (sameSet) {
          this.cdRef.markForCheck();
          return;
        }
        this.optionBindingsSource.set(
          next.map((o: Option) => ({
            ...o,
            selected: false,
            highlight: false,
            showIcon: false,
            feedback: undefined,
          }))
        );
        this.optionBindings.set(this.rebuildOptionBindings(this.optionBindingsSource()));
        this.renderReady.set(true);
        this.syncOptionsWithSelections();
      } else {
        this.optionBindingsSource.set([]);
        this.optionBindings.set([]);
      }
    });
  }

  override async ngOnInit(): Promise<void> {
    await this.initializeAnswerConfig();
    await this.initializeSharedOptionConfig();

    // Guard against the first render missing its options because the
    // options stream may not have emitted yet when the template binds.
    if (this.optionsToDisplay()?.length) {
      this.applyIncomingOptions(this.optionsToDisplay());
    }

    this.quizService
      .getCurrentQuestion(this.quizService.currentQuestionIndex)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((currentQuestion: QuizQuestion | null) => {
        if (!currentQuestion) return;

        // ROBUST MULTI-ANSWER CHECK
        const opts = currentQuestion.options || [];

        this.type.set(this.resolveQuestionType(currentQuestion?.questionText, opts));

        if (!this.hasComponentLoaded()) {
          this.hasComponentLoaded.set(true);
          this.syncOptionsWithSelections();
          this.quizQuestionComponentLoaded.emit();
        }
      });

    // Displays the unique options to the UI
    this.quizQuestionLoaderService.optionsStream$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((opts: Option[]) => {
        // Skip empty arrays to prevent BehaviorSubject initial emission
        // from clearing valid options that may have arrived via @Input
        if (!opts?.length) return;

        // Sync currentQuestionIndex + questionData with quizService on every
        // Q->Q emission. Without this, the dynamic AnswerComponent's
        // currentQuestionIndex stays at its init value (0) and questionData
        // stays at Q1's value (set once in configureDynamicInstance during
        // dynamic load). SOC mirrors questionData -> currentQuestion, so a
        // stale questionData makes pristine lookups (by questionText) target
        // Q1's data while the bindings are Q2's, returning the wrong
        // correctIndices and flipping the 2nd-correct click to sad.
        const svcIdx = this.quizService.currentQuestionIndex;
        if (typeof svcIdx === 'number' && Number.isFinite(svcIdx)) {
          this.currentQuestionIndex.set(svcIdx);
        }
        const liveQ = this.quizService.questions?.[svcIdx];
        if (liveQ) {
          this.questionData.set({ ...liveQ, options: opts });
          this.question.set({ ...liveQ });
        }

        this.incomingOptions.set(this.answerOptionsService.normalizeOptions(structuredClone(opts)));

        //  Clear prior icons and bindings (clean slate)
        this.optionBindings.set([]);
        this.renderReady.set(false);

        // Apply options synchronously (removed Promise.resolve to fix StackBlitz timing)
        this.applyIncomingOptions(this.incomingOptions(), {
          resetSelection: false,
        });
      });
  }

  public override async initializeSharedOptionConfig(): Promise<void> {
    await super.initializeSharedOptionConfig();
    if (this.sharedOptionConfig) {
      this.sharedOptionConfig.type = this.type();
    }
  }

  public override async onOptionClicked(payload: OptionClickedPayload): Promise<void> {
    if (!payload || !payload.option) return;

    const activeQuestionIndex = this.getActiveQuestionIndex();

    const enrichedOption = this.answerSelectionService.buildEnrichedSelectedOption(
      payload,
      activeQuestionIndex,
      this.optionsToDisplay()
    );

    this.selectedOption = enrichedOption;

    this.selectedOptions = this.answerSelectionService.updateSelectedOptionsArray(
      this.selectedOptions,
      enrichedOption,
      this.type()
    );

    const question = this.resolveQuestion(activeQuestionIndex);

    if (!question) return;

    const optionsSource = this.answerOptionsService.resolveOptionsSource(
      this.optionsToDisplay(),
      question
    );

    const isMultiAnswer = this.answerOptionsService.isMultipleAnswerQuestion(
      question,
      optionsSource,
      this.type()
    );

    this.answerSelectionService.syncSelectedOptionService(
      activeQuestionIndex,
      enrichedOption,
      isMultiAnswer
    );

    const complete = this.answerSelectionService.updateQuestionCompletionState(
      this.questionIndex(),
      question
    );

    this.answerSelectionService.updateScoringAndAnswerSelectedState(
      activeQuestionIndex,
      optionsSource,
      this.selectedOptions,
      isMultiAnswer,
      complete
    );

    const updatedBindings = this.answerBindingsService.updateVisualBindings(
      this.optionBindings(),
      enrichedOption,
      this.type()
    );

    this.optionBindings.set(updatedBindings);

    this.answerSelectionService.updateDotStatus(activeQuestionIndex, enrichedOption);

    this.emitCleanOptionClickedPayload(payload, enrichedOption);
  }

  override async loadDynamicComponent(
    _question: QuizQuestion,
    _options: Option[],
    _questionIndex: number
  ): Promise<void> {
    // AnswerComponent doesn't load dynamic children, so we
    // simply fulfill the contract and return a resolved promise.
    return;
    // If the base implementation does something essential, call:
    // return super.loadDynamicComponent(_question, _options, _questionIndex);
  }

  private resetSelectionState(): void {
    this.selectedOption = null;
    this.selectedOptions = [];
    this.selectedOptionIndex = -1;
    this.showFeedbackForOption = {};
  }

  /**
   * Single vs multiple, from the question's DECLARED type where available.
   *
   * The three call sites used to count correct options — `correctCount > 1`.
   * That makes question type an answer-key derivative, and it cannot survive
   * the bank leaving the browser. `GET /questions` declares the type
   * explicitly, and TopicQuizTypeRegistry holds it for the current quiz.
   *
   * `trueFalse` maps to 'single' here deliberately: it is a single-SELECTION
   * question wearing a label, and this component's `type` drives radio-vs-
   * checkbox rendering, which is a selection concern.
   *
   * REMOVE IN FINAL /questions RUNTIME CUTOVER — the count-based branch below
   * exists only because question CONTENT still comes from the local bank,
   * which carries no `type` field at all. A registry MISS is deliberately not
   * treated as 'single': that would silently turn multi-answer questions into
   * single-answer ones while the request is in flight.
   */
  private resolveQuestionType(
    questionText: string | null | undefined,
    options: readonly Option[]
  ): 'single' | 'multiple' {
    const declared = this.typeRegistry.isMultiAnswer(questionText);
    if (declared !== null) return declared ? 'multiple' : 'single';

    // REMOVE IN FINAL /questions RUNTIME CUTOVER.
    const correctCount = (options ?? []).filter((o) => isOptionCorrect(o)).length;
    return correctCount > 1 ? 'multiple' : 'single';
  }

  private applyIncomingOptions(options: Option[], config: { resetSelection?: boolean } = {}): void {
    const normalized = this.answerOptionsService.normalizeOptions(options);
    const nextOptions = normalized.map((option: Option) => ({
      ...option,
      selected: false,
      highlight: false,
      showIcon: false,
      feedback: undefined,
    }));

    if (config.resetSelection ?? true) this.resetSelectionState();

    // Recalculate type from the incoming options' correct flags.
    // Without this, navigating from a multi-answer question (e.g. Q4) to a
    // single-answer question (e.g. Q5) would leave type='multiple', causing
    // SOC to render checkboxes and use multi-answer interaction logic.
    // NOT registry-backed, deliberately. This runs while `questionData()` may
    // still hold the PREVIOUS question (see the note above about stale
    // questionData), so a text-keyed type lookup here would return the wrong
    // question's type — which is exactly what broke multi-answer scoring and
    // timeout colouring when it was tried. The incoming OPTIONS are the only
    // thing reliably describing the next question at this point.
    //
    // REMOVE IN FINAL /questions RUNTIME CUTOVER: once questions arrive from
    // the API they carry their own declared type, so this site reads it from
    // the question itself rather than needing a lookup key at all.
    const correctCount = nextOptions.filter((o) => isOptionCorrect(o)).length;
    this.type.set(correctCount > 1 ? 'multiple' : 'single');

    this.optionsToDisplay.set(nextOptions);
    this.optionBindingsSource.set(nextOptions.map((option) => ({ ...option })));

    if (this.sharedOptionConfig) {
      this.sharedOptionConfig = {
        ...this.sharedOptionConfig,
        type: this.type(),
        optionsToDisplay: nextOptions.map((option: Option) => ({ ...option })),
      };
    }

    this.optionBindings.set(this.rebuildOptionBindings(this.optionBindingsSource()));
    this.renderReady.set(true);
    this.syncOptionsWithSelections();
  }

  /**
   * Hydrates the local 'optionsToDisplay' or Input options with state
   * from the SelectedOptionService.
   */
  private syncOptionsWithSelections(): void {
    const index = this.currentQuestionIndex();

    if (index === null || index === undefined || index < 0) return;

    const savedSelections = this.selectedOptionService.getSelectedOptionsForQuestion(index) ?? [];

    if (!savedSelections.length || !this.optionsToDisplay()?.length) return;

    const isMulti = this.type() === 'multiple';

    for (const option of this.optionsToDisplay()) {
      if (isMulti) {
        option.selected = false;
        continue;
      }

      const savedIds = new Set(savedSelections.map((selection) => String(selection.optionId)));

      const savedTexts = new Set(savedSelections.map((selection) => norm(selection.text)));

      const idMatch = option.optionId != null && savedIds.has(String(option.optionId));

      const textMatch = !!(option.text && savedTexts.has(norm(option.text)));

      option.selected = idMatch || textMatch;
    }

    const updatedBindings = this.answerBindingsService.hydrateBindingsFromSavedSelections(
      this.optionBindings(),
      savedSelections,
      isMulti
    );

    this.optionBindings.set(updatedBindings);

    const formGroup = this.form();
    if (this.type() === 'single' && formGroup) {
      const selectedId = savedSelections[0]?.optionId;

      if (selectedId != null) {
        formGroup.patchValue({ selectedOptionId: selectedId }, { emitEvent: false });
      }
    }
  }

  private async initializeAnswerConfig(): Promise<void> {
    if (!this.sharedOptionConfig) await this.initializeSharedOptionConfig();

    if (this.sharedOptionConfig) {
      this.sharedOptionConfig.type = this.type();
    } else {
      // failed to initialize sharedOptionConfig
    }
  }

  private getActiveQuestionIndex(): number {
    const idx = this.currentQuestionIndex();
    return typeof idx === 'number' ? idx : 0;
  }

  private resolveQuestion(activeQuestionIndex: number): QuizQuestion | undefined {
    const serviceQuestion = this.quizService.questions?.[activeQuestionIndex];
    const question = serviceQuestion ?? this.questionData();

    if (!question) {
      console.warn(
        '[AnswerComponent] No question available for active index:',
        activeQuestionIndex
      );

      return undefined;
    }

    if (!serviceQuestion) {
      console.warn(
        '[AnswerComponent] Falling back to questionData() because quizService.questions did not contain question at index:',
        activeQuestionIndex
      );
    }

    return question;
  }

  private emitCleanOptionClickedPayload(
    originalPayload: OptionClickedPayload,
    enrichedOption: SelectedOption
  ): void {
    const cleanPayload: OptionClickedPayload = {
      option: enrichedOption,
      index: originalPayload.index,
      checked: enrichedOption.selected === true,
      wasReselected: originalPayload.wasReselected ?? false,
    };

    this.optionClicked.emit(cleanPayload);
  }

  // Rebuild optionBindings from the latest optionsToDisplay.
  private rebuildOptionBindings(options: Option[]): OptionBindings[] {
    const rebuilt = this.answerBindingsService.rebuildOptionBindings(options);

    this.optionBindings.set(rebuilt);
    this.renderReady.set(true);

    requestAnimationFrame(() => {
      this.cdRef.markForCheck();
    });

    return rebuilt;
  }
}
