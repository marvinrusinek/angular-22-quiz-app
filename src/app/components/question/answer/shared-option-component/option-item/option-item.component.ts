import { ChangeDetectionStrategy, ChangeDetectorRef, Component, computed, DestroyRef,
  effect, inject, input, OnInit, output, ViewEncapsulation
} from '@angular/core';
import { NgClass, NgTemplateOutlet } from '@angular/common';
import { FormGroup, ReactiveFormsModule } from '@angular/forms';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatRadioModule } from '@angular/material/radio';
import { MatIconModule } from '@angular/material/icon';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { FeedbackProps } from '../../../../../shared/models/FeedbackProps.model';
import { Option } from '../../../../../shared/models/Option.model';
import { OptionBindings } from '../../../../../shared/models/OptionBindings.model';
import { SelectedOption } from '../../../../../shared/models/SelectedOption.model';
import { SharedOptionConfig } from '../../../../../shared/models/SharedOptionConfig.model';

import { OptionService } from '../../../../../shared/services/options/view/option.service';
import { QuestionResolutionService } from '../../../../../shared/services/options/engine/question-resolution.service';
import { QuizService } from '../../../../../shared/services/data/quiz.service';
import { SelectedOptionService } from '../../../../../shared/services/state/selectedoption.service';
import { TimerService } from '../../../../../shared/services/features/timer/timer.service';
import { FeedbackPolicyService } from '../../../../../shared/services/features/interview/feedback-policy.service';

import { OptionItemTimerStateService } from '../../../../../shared/services/options/view/option-item-timer-state.service';

import {
  hasAuthorizedCorrectSelection as hasAuthCorrectSelection,
  isCurrentOptionCorrect as isOptCorrect,
  isTimeoutRevealAuthorized
} from './helpers/option-item-correctness';
import { TopicQuizTypeRegistry } from '../../../../../shared/services/api/topic-quiz-type-registry.service';
import { QuestionVerdictService } from '../../../../../shared/services/features/verdict/question-verdict.service';
import { isSelectedForCurrentQuestion as isSelForCurrentQ } from './helpers/option-item-selection-matcher';

import { norm } from '../../../../../shared/utils/text-norm';

import { correctAnswerAnim } from '../../../../../animations/animations';
import { HighlightOptionDirective } from '../../../../../directives/highlight-option.directive';
import { SharedOptionConfigDirective } from '../../../../../directives/shared-option-config.directive';

// Option background colors — matches SCSS variables in _variables.scss
const CORRECT_COLOR = '#43e756';
const INCORRECT_COLOR = '#ff0000';
const DISABLED_COLOR = '#a0a0a0';

export type OptionUIEventKind = 'change' | 'interaction' | 'contentClick';

export interface OptionUIEvent {
  optionId: number;
  displayIndex: number;
  kind: OptionUIEventKind;
  inputType: 'radio' | 'checkbox';
  nativeEvent: any;
}

@Component({
  selector: 'app-option-item',
  standalone: true,
  imports: [
    NgClass,
    NgTemplateOutlet,
    ReactiveFormsModule,
    MatCheckboxModule,
    MatRadioModule,
    MatIconModule,
    HighlightOptionDirective,
    SharedOptionConfigDirective
  ],
  templateUrl: './option-item.component.html',
  styleUrls: ['./option-item.component.scss'],
  encapsulation: ViewEncapsulation.None,
  animations: [correctAnswerAnim],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class OptionItemComponent implements OnInit {
  // ── injects ─────────────────────────────────────────────────────
  private readonly optionService = inject(OptionService);
  private readonly questionResolution = inject(QuestionResolutionService);
  private readonly quizService = inject(QuizService);
  /** Declared question type (single vs multi) — NOT derived from the answer key. */
  private readonly typeRegistry = inject(TopicQuizTypeRegistry);
  /** Correctness authority for per-option highlighting. */
  private readonly verdicts = inject(QuestionVerdictService);
  private readonly selectedOptionService = inject(SelectedOptionService);
  private readonly timerService = inject(TimerService);
  private readonly timerState = inject(OptionItemTimerStateService);
  private readonly feedbackPolicy = inject(FeedbackPolicyService);
  private readonly cdRef = inject(ChangeDetectorRef);
  private readonly destroyRef = inject(DestroyRef);

  // ── outputs ─────────────────────────────────────────────────────
  readonly optionUI = output<OptionUIEvent>();

  // ── inputs ──────────────────────────────────────────────────────
  readonly binding = input.required<OptionBindings>();
  readonly displayIndex = input.required<number>();
  readonly type = input<'single' | 'multiple'>('single');
  readonly form = input.required<FormGroup>();
  readonly shouldResetBackground = input(false);
  readonly feedbackConfig = input<FeedbackProps>();
  readonly sharedOptionConfig = input.required<SharedOptionConfig>();
  readonly currentQuestionIndex = input(0);
  readonly timerExpired = input(false);

  readonly option = computed(() => this.binding().option);

  readonly optionId = computed(() => {
    const id = this.option()?.optionId;
    return (id != null && id !== -1) ? Number(id) : this.displayIndex();
  });

  // NOTE: option text / icon visibility / icon name are intentionally plain
  // method calls in the template (getOptionDisplayText / shouldShowIcon /
  // getOptionIcon), NOT computed(). They depend on imperatively-mutated state
  // (_wasSelected, option.showIcon/highlight/_autoRevealedCorrect) that isn't
  // signal-backed, so a computed would cache a stale value and the icon could
  // fail to appear/clear on click. Methods re-evaluate every CD pass.

  // ── remaining variables ─────────────────────────────────────────
  private _wasSelected = false;
  private _lastQuestionIndex = -1;
  // Tracks whether this component instance has seen a real user click.
  // Used to gate destructive visual-state clears in the question-change
  // effect below: on refresh the parent may briefly emit
  // currentQuestionIndex=0 before the real index resolves, and the second
  // run would wipe the refresh-restored state if we cleared unconditionally.
  private _userHasClicked = false;
  // Tracks whether the timer expired for the current question. Used to
  // clear timer-expiry highlighting on question change even when the
  // user never clicked an option (_userHasClicked is false).
  private _wasTimerExpired = false;
  // Direct timer expiry flag — set by subscribing to timerService.expired$
  // directly, bypassing the parent OnPush binding chain.
  private _directTimerExpired = false;
  private _directTimerExpiredForIndex = -1;

  constructor() {
    // Question-change cleanup. Replaces the prior ngOnChanges
    // `changes['currentQuestionIndex']` block — necessary because
    // currentQuestionIndex is now a signal input and signal-input
    // changes don't fire ngOnChanges.
    effect(() => {
      const nextQuestionIndex = Number(this.currentQuestionIndex() ?? -1);
      if (!Number.isFinite(nextQuestionIndex) ||
          nextQuestionIndex === this._lastQuestionIndex) return;
      // Always clear the _wasSelected latch on question change.
      // _wasSelected is per-visit click evidence; carrying it across
      // questions (including restart) wrongly persists highlights.
      this._wasSelected = false;
      // Clear additional stale state when navigating AWAY from a question
      // the user actually interacted with. Gated separately so we don't
      // wipe binding flags on a fresh first-visit.
      if (this._lastQuestionIndex !== -1 &&
          (this._userHasClicked || this._wasTimerExpired)) {
        this._wasTimerExpired = false;
        this._directTimerExpired = false;
        this._directTimerExpiredForIndex = -1;
        const b = this.binding();
        if (b) {
          b.isSelected = false;
          b.disabled = false;
          b.cssClasses = {};
          if (b.option) {
            b.option.selected = false;
            b.option.highlight = false;
            b.option.showIcon = false;
          }
        }
        this._userHasClicked = false;
      }
      this._lastQuestionIndex = nextQuestionIndex;
    });

    // shouldResetBackground reset. Truthy → clear sticky highlight latch.
    effect(() => {
      if (this.shouldResetBackground()) this._wasSelected = false;
    });

    // Latch timer expiry so the question-change effect's cleanup branch
    // also clears timer-expired highlighting when the user advances
    // without ever having clicked an option.
    effect(() => {
      // Touch the timerExpired input so this effect re-runs on changes.
      this.timerExpired();
      if (this.isTimerExpiredForThisQuestion() && !this._wasTimerExpired) {
        this._wasTimerExpired = true;
      }
    });

    // Sticky highlight latch. Once the binding's isSelected goes true
    // during a live interaction (_userHasClicked), keep _wasSelected true
    // for the rest of the question. _userHasClicked guard prevents
    // transient init paths (processOptionBindings, generateOptionBindings)
    // from latching highlights on options the user never clicked.
    effect(() => {
      if (this.binding()?.isSelected && this._userHasClicked) {
        this._wasSelected = true;
      }
    });

    // Re-check on every selection mutation. isDisabled() reads selections
    // and pristine corrects for multi-answer mode; without this, sibling
    // OnPush option-items don't re-evaluate when the user picks a new
    // option (their `b` input ref doesn't always change in the click path).
    effect(() => {
      this.selectedOptionService.selectedOptionsMapSig();
      this.applyMultiAnswerDisableState();
      this.cdRef.markForCheck();
    });
  }

  ngOnInit(): void {
    this.timerService.expired$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this._directTimerExpired = true;
        this._directTimerExpiredForIndex = this.timerService.expiredForQuestionIndexSig();
        this.cdRef.markForCheck();
      });
  }

  getOptionDisplayText(): string {
    return this.optionService.getOptionDisplayText(this.binding().option, this.displayIndex());
  }

  getOptionIcon(_option?: any, _i?: number): string {
    // Interview Mode: never reveal correct/incorrect icons during the interview.
    if (this.feedbackPolicy.isDeferred()) {
      return '';
    }
    // AUTO-REVEAL backup: persistent custom flag wins over any state that
    // might wipe option.showIcon (mirrors the backup in
    // getOptionBackgroundColor that paints the green background).
    if (this.binding()?._autoRevealedCorrect === true ||
        this.binding()?.option?._autoRevealedCorrect === true) {
      return 'check';
    }
    if (this.isTimerStamped()) {
      return this.isStampedCorrect() ? 'check' : 'close';
    }
    if (this.shouldShowFeedback() || this.shouldShowCorrectOnTimeout()) {
      return this.isCurrentOptionCorrect() ? 'check' : 'close';
    }
    return this.binding().optionIcon || '';
  }

  getOptionClasses(): { [key: string]: boolean } {
    const classes = { ...this.binding().cssClasses };

    // Interview Mode: suppress all correctness classes AND any stale highlight/
    // selection classes carried over from a prior question, then show only a
    // NEUTRAL "selected" marker for THIS question's saved selection (authoritative
    // per current index — never the possibly-stale binding flag). No right/wrong
    // signal (colors, icons, correct/incorrect classes all off).
    if (this.feedbackPolicy.isDeferred()) {
      return {
        ...classes,
        'correct-option': false,
        'incorrect-option': false,
        'selected-option': false,
        highlighted: false,
        selected: false,
        'interview-selected': this.isSelectedForCurrentQuestion()
      };
    }

    const revisitClasses = this.getRevisitOptionClasses(classes);
    if (revisitClasses) return revisitClasses;

    if (this.isTimerStamped()) return classes;

    if (this.isTimerExpiredForThisQuestion()) {
      return this.getTimerExpiredOptionClasses(classes);
    }

    return this.getDefaultOptionClasses(classes);
  }

  private getTimerExpiredOptionClasses(
    classes: { [key: string]: boolean }
  ): { [key: string]: boolean } {
    const wasSelected =
      this.binding()?.isSelected ||
      !!this.binding()?.option?.highlight ||
      this._wasSelected ||
      this.isSelectedForCurrentQuestion();

    const showCorrect = this.shouldShowCorrectOnTimeout();

    return {
      ...classes,
      'correct-option': showCorrect,
      'incorrect-option': wasSelected && !this.isCurrentOptionCorrect()
    };
  }

  private getDefaultOptionClasses(
    classes: { [key: string]: boolean }
  ): { [key: string]: boolean } {
    const isCorrect = this.isCurrentOptionCorrect();
    const shouldHighlight = this.shouldHighlightOption();

    if (!shouldHighlight) {
      return this.clearHighlightClasses(classes);
    }

    return {
      ...classes,
      'correct-option': isCorrect,
      'incorrect-option': !isCorrect
    };
  }

  private clearHighlightClasses(
    classes: { [key: string]: boolean }
  ): { [key: string]: boolean } {
    return {
      ...classes,
      'correct-option': false,
      'incorrect-option': false,
      highlighted: false,
      selected: false,
      'selected-option': false
    };
  }

  private getRevisitOptionClasses(
    classes: { [key: string]: boolean }
  ): { [key: string]: boolean } | null {
    // Defensive: a throw here must fall through to the timer/default class
    // logic (return null), never break the option render. Mirrors the
    // try/catch the original inline getOptionClasses() had around this block.
    try {
      const questionIndex = this.resolveQuestionIndex();

      const {
        fullyResolvedCorrect,
        fullyResolvedWrong,
        correctOpts
      } = this.questionResolution.resolveQuestionState(questionIndex, {
        includeWrongDetection: true
      });

      const option = this.binding()?.option;

      if (fullyResolvedCorrect) {
        return this.getFullyResolvedCorrectClasses(classes, option, correctOpts, questionIndex);
      }

      // Engaged-but-partial question on revisit: repaint the first-visit colors
      // from the display-only snapshot (green selected-correct, red selected-
      // wrong, neutral untouched). Gated on !_userHasClicked so a fresh click
      // re-engages live interaction. This snapshot never feeds the auto-reveal,
      // so restoring it can't trigger the "all incorrects selected" reveal.
      if (!this._userHasClicked &&
          this.selectedOptionService.hasRevisitDisplay(questionIndex)) {
        return this.getPartialRevisitClasses(classes, option, correctOpts, questionIndex);
      }

      if (fullyResolvedWrong && !this._userHasClicked) {
        return this.clearRevisitClasses(classes);
      }

      return null;
    } catch (err: unknown) {
      console.error('getRevisitOptionClasses failed:', err);
      return null;
    }
  }

  private getFullyResolvedCorrectClasses(
    classes: { [key: string]: boolean },
    option: Option | undefined,
    correctOpts: Option[],
    questionIndex: number
  ): { [key: string]: boolean } {
    const isCanonCorrectHere =
      this.questionResolution.isOptionCanonCorrect(option, correctOpts);

    if (isCanonCorrectHere) {
      return {
        ...classes,
        selected: true,
        'selected-option': true,
        'correct-option': true,
        'incorrect-option': false,
        highlighted: true,
        'disabled-option': false
      };
    }

    const wasClickedIncorrect =
      this.wasClickedIncorrectOnRevisit(option, questionIndex);

    return {
      ...classes,
      selected: false,
      'selected-option': false,
      'correct-option': false,
      'incorrect-option': wasClickedIncorrect,
      highlighted: false,
      'disabled-option': !wasClickedIncorrect
    };
  }

  // Repaint an engaged-but-partial question on revisit to match how the user
  // left it: each option that was selected shows green (if canon-correct) or red
  // (if incorrect); untouched options stay neutral + interactive so the user can
  // keep answering. Driven purely by the display-only revisit snapshot.
  private getPartialRevisitClasses(
    classes: { [key: string]: boolean },
    option: Option | undefined,
    correctOpts: Option[],
    questionIndex: number
  ): { [key: string]: boolean } {
    const wasSelected = this.selectedOptionService.wasTextSelectedOnLastVisit(
      questionIndex, option?.text ?? ''
    );
    if (!wasSelected) {
      // Untouched on the last visit → neutral, still clickable on revisit.
      return this.clearRevisitClasses(classes);
    }
    const isCorrect = this.questionResolution.isOptionCanonCorrect(option, correctOpts);
    return {
      ...classes,
      selected: true,
      'selected-option': true,
      'correct-option': isCorrect,
      'incorrect-option': !isCorrect,
      highlighted: true,
      'disabled-option': false
    };
  }

  private wasClickedIncorrectOnRevisit(
    option: Option | undefined,
    questionIndex: number
  ): boolean {
    if (
      this._wasSelected ||
      this._userHasClicked ||
      !!this.binding()?.option?.showIcon ||
      !!this.binding()?.option?.highlight
    ) {
      return true;
    }

    const optionText = norm(option?.text);
    if (!optionText) return false;

    return this.selectedOptionService.wasOptionSelectedForQuestion(
      questionIndex,
      optionText
    );
  }

  private clearRevisitClasses(
    classes: { [key: string]: boolean }
  ): { [key: string]: boolean } {
    return { ...this.clearHighlightClasses(classes), 'disabled-option': false };
  }

  getOptionCursor(): string {
    return this.binding().optionCursor || 'default';
  }

  isNotAllowedCursor(): boolean {
    return this.getOptionCursor() === 'not-allowed';
  }

  isDisabled(): boolean {
    const auto = this.autoRevealDisabled();
    if (auto !== undefined) return auto;

    const revisit = this.revisitOverrideDisabled();
    if (revisit !== undefined) return revisit;

    // Timer-expiry handler stamped all bindings as disabled
    if (this.isTimerStamped()) { return true; }

    const _qIdx = this.quizService.currentQuestionIndex ?? this.currentQuestionIndex();
    const _type = this.resolveEffectiveDisabledType(_qIdx);

    if (_type === 'multiple') {
      return this.isMultiAnswerOptionDisabled(_qIdx);
    }

    return this.isSingleAnswerOptionDisabled();
  }

  // AUTO-REVEAL: correct options stay enabled (green), incorrect are disabled.
  private autoRevealDisabled(): boolean | undefined {
    const b = this.binding();
    if (b?._autoRevealedCorrect === true ||
        b?.option?._autoRevealedCorrect === true) {
      return false;  // correct option — not disabled
    }
    if (b?.disabled && b?.cssClasses?.['incorrect-option']) {
      return true;  // incorrect option in auto-reveal — disabled
    }
    return undefined;
  }

  // Previous-revisit override: on a FULLY-resolved correct question, every
  // INCORRECT option must render disabled (dark gray).
  private revisitOverrideDisabled(): boolean | undefined {
    try {
      const _qIdxRev = this.resolveQuestionIndex();

      const res = this.questionResolution.resolveQuestionState(_qIdxRev);
      if (res.fullyResolvedCorrect) {
        const isCanonCorrectHere = this.questionResolution.isOptionCanonCorrect(
          this.binding()?.option, res.correctOpts
        );
        if (!isCanonCorrectHere) return true;
      }
    } catch (err: unknown) { console.error('isDisabled revisit-override failed:', err); }
    return undefined;
  }

  // RENDERING-LAYER TYPE GUARD: trust the DECLARED type over the [type] input
  // binding, which can resolve 'single' in the template from mutated/missing
  // live flags (e.g. Q2 of the dependency-injection quiz).
  //
  // This used to ask the pristine bank whether the question had more than one
  // correct option — question TYPE inferred from the ANSWER KEY, which cannot
  // survive the bank's removal. The registry carries the type the API declares:
  // the same fact, stated by an authority instead of counted from the answers.
  //
  // A registry MISS answers null and is deliberately NOT treated as 'single' —
  // that would silently turn a multi-answer question single while the type
  // request is in flight. Unknown leaves the input binding untouched.
  private resolveEffectiveDisabledType(_qIdx: number): string {
    const _type = this.type();
    if (_type === 'multiple' || !this.binding()?.option?.text) return _type;

    const declared = this.typeRegistry.isMultiAnswer(this.questionTextAt(_qIdx));
    return declared === true ? 'multiple' : _type;
  }

  /** The question text at a display index, shuffle-safe. */
  private questionTextAt(qIdx: number): string | undefined {
    return (this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[qIdx]?.questionText
      ?? (this.quizService as any)?.questions?.[qIdx]?.questionText;
  }

  /** @see hasAuthorizedCorrectSelection — the single-answer lock authority. */
  private hasAuthorizedCorrectSelection(qIdx: number): boolean {
    return hasAuthCorrectSelection(this.quizService, qIdx, this.verdicts);
  }

  // For MULTIPLE mode, disable purely by data: when the user has
  // selected every pristine-correct option, every other (unselected,
  // incorrect) option becomes disabled. Reads selectedOptionsMapSig
  // directly so Angular's signal tracking auto-marks this OnPush
  // component dirty whenever selections mutate (no need for manual
  // markForCheck or input-ref-change tricks).
  private isMultiAnswerOptionDisabled(_qIdx: number): boolean {
    if (this.isTimerExpiredForThisQuestion()) { return true; }

    if (this.quizService.isMultiAnswerComplete(_qIdx)) {
      // Read both signals directly — registers template dependencies so this
      // OnPush component re-renders when selections change.
      const selectionsMap = this.selectedOptionService.selectedOptionsMapSig();
      const selections = selectionsMap.get(_qIdx) ?? [];
      const selectedTexts = new Set(
        selections.map((s: SelectedOption) => norm(s?.text)).filter((t: string) => !!t)
      );
      // Union the reliable, auto-reveal-invisible UI-selected-texts (live bindings
      // ∪ first-visit snapshot, published by the shared-option component). This is
      // what makes "complete a partial multi-answer on revisit" register as
      // all-correct even though selectedOptionsMap is wiped/flaky on revisit.
      for (const t of this.selectedOptionService.uiSelectedTextsForQuestion(_qIdx)) {
        selectedTexts.add(t);
      }
      const myText = norm(this.binding()?.option?.text);
      return !selectedTexts.has(myText);
    }

    // Fallback to the legacy flag path if pristine resolution failed
    // (no quizInitialState match, etc.).
    if (this.quizService.isQuestionResolved(_qIdx) && this.binding()?.disabled === true) {
      return true;
    }
    return false;
  }

  // SINGLE-ANSWER MODE — single, direct rule:
  //   Lock = NOT-selected AND the VERDICT has confirmed one of the user's own
  //          picks correct for this question.
  // The currently-selected option is never disabled.
  // While no correct option has been selected, every option stays clickable.
  private isSingleAnswerOptionDisabled(): boolean {
    if (this.binding()?.isSelected) return false;

    const qIdx = this.quizService.currentQuestionIndex ?? this.currentQuestionIndex();
    // Read signal directly — OnPush auto-tracks selection mutations.
    const selectionsMapSig = this.selectedOptionService.selectedOptionsMapSig();
    const selections = selectionsMapSig.get(qIdx) ?? [];
    if (selections.length === 0) return false;

    // Lock once the VERDICT says one of the user's OWN picks was correct.
    //
    // This used to match selection texts against the pristine correct set, with
    // an `isOptionCorrect(s)` flag fallback — both answer-key reads, and the
    // second trusted a flag copied off the bank onto the selection record. The
    // verdict answers the same question about the same picks, and says nothing
    // about options the user never touched.
    return this.hasAuthorizedCorrectSelection(qIdx);
  }

  shouldShowIcon(_option?: any, _i?: number): boolean {
    // Interview Mode: no correctness icons during the interview.
    if (this.feedbackPolicy.isDeferred()) {
      return false;
    }
    // AUTO-REVEAL backup: persistent custom flag wins over downstream
    // pipelines that wipe option.showIcon back to false (mirrors the
    // backup in getOptionBackgroundColor that paints the green background).
    if (this.binding()?._autoRevealedCorrect === true ||
        this.binding()?.option?._autoRevealedCorrect === true) {
      return true;
    }
    if (this.isTimerStamped()) {
      if (this.isStampedCorrect()) return true;
      return !!this.binding()?.isSelected || this._wasSelected;
    }
    if (this.isTimerExpiredForThisQuestion()) {
      // Show icon for correct options AND for any option the user
      // actually selected (so a selected wrong answer keeps its X).
      if (this.shouldShowCorrectOnTimeout()) return true;
      return this.binding()?.isSelected
        || !!this.binding()?.option?.highlight
        || this._wasSelected
        || this.isSelectedForCurrentQuestion();
    }

    // Hard Guard: On refresh (user hasn't clicked), ONLY trust the
    // authoritative saved selection state. The binding flags
    // (highlight, showIcon, isSelected) can be transiently set by
    // processOptionBindings / synchronizeOptionBindings before
    // rehydrate clears them, causing a flash. _wasSelected is only
    // true after a live user click, so it's safe.
    if (!this._userHasClicked && !this._wasSelected) {
      // During LIVE interaction (user clicked a sibling, not this option),
      // the click pipeline (OIS/OUS/SOC backstop) authoritatively sets
      // b.option.showIcon=false on non-clicked, non-history options.
      // Trust that flag to prevent service-level false positives from
      // effectiveId collisions or stale entries.
      // On refresh/initial-load, showIcon is typically undefined (not
      // explicitly false), so the service check below still runs.
      if (this.binding()?.option?.showIcon === false) return false;

      // No live click this session → only show icon if a saved
      // selection actually matches this exact binding position.
      return this.isSelectedForCurrentQuestion();
    }

    const hasAnyPerBindingSignal =
      this.binding()?.option?.showIcon === true
      || this.binding()?.isSelected === true
      || !!this.binding()?.option?.highlight
      || this._wasSelected;
    if (!hasAnyPerBindingSignal) {
      if (this.binding()?.disabled === true) return false;
      if (!this.isSelectedForCurrentQuestion()) return false;
    }

    return this.shouldHighlightOption();
  }

  shouldShowCorrectOnTimeout(): boolean {
    if (!this.isTimerExpiredForThisQuestion()) return false;

    // TIME RUNNING OUT DOES NOT AUTHORIZE A REVEAL. The expiry flag is set
    // locally and instantly; the answers come from the server. Between those
    // two moments this must paint nothing, or it would be inventing
    // correctness — which is exactly what the old `.correct` fallback did.
    if (!this.isTimeoutRevealAuthorized()) return false;

    // Authorized: reveal ALL correct answers, including options the user never
    // selected and never flagged.
    return this.isCurrentOptionCorrect();
  }

  /** Has the expired verdict for THIS question arrived? */
  private isTimeoutRevealAuthorized(): boolean {
    const qIdx = this.quizService.currentQuestionIndex ?? this.currentQuestionIndex();
    return isTimeoutRevealAuthorized(this.quizService, qIdx, this.verdicts);
  }

  getOptionBackgroundColor(): string | null {
    // Interview Mode: no correctness background color during the interview
    // (neutral selection is conveyed by the 'interview-selected' class instead).
    if (this.feedbackPolicy.isDeferred()) {
      return null;
    }
    const auto = this.autoRevealColor();
    if (auto !== undefined) return auto;

    const fullyResolved = this.fullyResolvedRevisitColor();
    if (fullyResolved !== undefined) return fullyResolved;

    const partial = this.partialMultiSuppressColor();
    if (partial !== undefined) return partial;

    const timer = this.timerColor();
    if (timer !== undefined) return timer;

    const correctPerfect = this.correctPerfectColor();
    if (correctPerfect !== undefined) return correctPerfect;

    if (!this.shouldHighlightOption()) {
      return this.suppressedHighlightColor();
    }

    // Green if correct, red if incorrect
    return this.isCurrentOptionCorrect() ? CORRECT_COLOR : INCORRECT_COLOR;
  }

  // AUTO-REVEAL: persistent flag wins over all other guards.
  // Must be checked FIRST — the revisit guard below would return null
  // for unclicked correct options on unresolved multi-answer questions,
  // suppressing the green highlight that auto-reveal set.
  private autoRevealColor(): string | undefined {
    if (this.binding()?._autoRevealedCorrect === true ||
        this.binding()?.option?._autoRevealedCorrect === true) {
      return CORRECT_COLOR;
    }
    return undefined;
  }

  // Previous-revisit: on a fully-resolved correct question, correct
  // options must be green and incorrect must be dark gray.
  private fullyResolvedRevisitColor(): string | undefined {
    try {
      const _qIdxFR = this.resolveQuestionIndex();
      const resFR = this.questionResolution.resolveQuestionState(_qIdxFR, { includeDot: false });
      if (resFR.fullyResolvedCorrect) {
        const isCanonCorrect = this.questionResolution.isOptionCanonCorrect(
          this.binding()?.option, resFR.correctOpts
        );
        return isCanonCorrect ? CORRECT_COLOR : DISABLED_COLOR;
      }
    } catch (err: unknown) { console.error('getOptionBackgroundColor fullyResolved check failed:', err); }
    return undefined;
  }

  // Imperfect-revisit / partial-multi guard: suppress green for unpicked
  // correct options on partial multi-answer states.
  private partialMultiSuppressColor(): null | undefined {
    try {
      if (!this._userHasClicked && !this.binding()?.isSelected) {
        // If this option is already LOCKED (disabled because every correct answer
        // is now selected — including the "completed a partial M-A on revisit"
        // case), the question is effectively complete: let it gray via the
        // disabled path rather than suppressing the color.
        if (this.isDisabled()) return undefined;

        const _qIdxRev = this.resolveQuestionIndex();

        const res = this.questionResolution.resolveQuestionState(_qIdxRev, { includeDot: false });
        if (!res.fullyResolvedCorrect && res.isCanonMulti) {
          return null;
        }
      }
    } catch (err: unknown) { console.error('getOptionBackgroundColor revisit-guard failed:', err); }
    return undefined;
  }

  // Timer-expiry handler stamped this binding — use stamped classes for color
  private timerColor(): string | null | undefined {
    if (this.isTimerStamped()) {
      if (this.isStampedCorrect()) return CORRECT_COLOR;
      const wasSelected = this.binding()?.isSelected || this._wasSelected;
      return wasSelected && !this.isStampedCorrect() ? INCORRECT_COLOR : null;
    }
    if (this.isTimerExpiredForThisQuestion()) {
      if (this.shouldShowCorrectOnTimeout()) return CORRECT_COLOR;
      // Keep the user's wrong selection red on timer expiry.
      const wasSelected = this.binding()?.isSelected
        || !!this.binding()?.option?.highlight
        || this._wasSelected
        || this.isSelectedForCurrentQuestion();
      return wasSelected && !this.isCurrentOptionCorrect() ? INCORRECT_COLOR : null;
    }
    return undefined;
  }

  private correctPerfectColor(): string | undefined {
    if (this.isCurrentOptionCorrect()) {
      const _qIdxARBg = this.quizService.currentQuestionIndex ?? this.currentQuestionIndex();
      if (this.quizService.isQuestionResolved(_qIdxARBg) ||
          this.binding()?.cssClasses?.['correct-option'] === true) {
        return CORRECT_COLOR;
      }
    }
    return undefined;
  }

  // Color when shouldHighlightOption() is false (suppressed-highlight path).
  private suppressedHighlightColor(): string | null {
    const saSuppress = this.singleAnswerNoCorrectSuppress();
    if (saSuppress !== undefined) return saSuppress;

    const saIncorrect = this.singleAnswerIncorrectRed();
    if (saIncorrect !== undefined) return saIncorrect;

    // Dark gray for disabled unselected options (e.g. remaining
    // incorrect after all correct answers selected in multi-answer).
    // Gate on isDisabled() (authoritative) instead of the raw
    // binding.disabled flag — the flag can linger as true from a
    // prior question's timer-expiry stamping while isDisabled()
    // correctly returns false, producing a gray-but-enabled option.
    if (this.isDisabled() && !this.binding()?.isSelected) return DISABLED_COLOR;

    const maGray = this.multiAnswerGray();
    if (maGray !== undefined) return maGray;

    return null;
  }

  // Single-answer suppression: while no correct option has been selected
  // for this question, never gray any non-selected option. Upstream
  // pipelines occasionally leak b.disabled=true onto previously-clicked
  // and never-clicked single-answer bindings, which would otherwise
  // paint them gray after the user picks a 2nd incorrect option. The
  // user must remain free to keep trying with a clear visual state.
  private singleAnswerNoCorrectSuppress(): null | undefined {
    const _qIdxSA = this.quizService.currentQuestionIndex ?? this.currentQuestionIndex();
    if (this.type() === 'single' && !this.binding()?.isSelected) {
      // Suppress the grey while no pick has been AUTHORIZED correct.
      //
      // The pristine lookup this replaces did two jobs: confirming the question
      // was single-answer (its correct set had exactly one member), and testing
      // the user's selections against the answer key. `type()` already answers
      // the first — registry-backed via resolveEffectiveDisabledType — and the
      // verdict answers the second, about the user's own picks only.
      if (!this.hasAuthorizedCorrectSelection(_qIdxSA)) return null;
    }
    return undefined;
  }

  // Single-answer: previously-clicked incorrect options should show
  // red (not gray) once the correct answer has been found. Check
  // binding flags first, then fall back to _selectionHistory
  // (accumulative — unlike selectedOptionsMapSig which only keeps
  // the latest pick for single-answer questions).
  private singleAnswerIncorrectRed(): string | undefined {
    if (this.type() === 'single' && !this.binding()?.isSelected && !this.isCurrentOptionCorrect()) {
      const b = this.binding();
      const wasClickedByFlags = b?.option?.showIcon || b?.option?.highlight || b?.highlightIncorrect;
      if (wasClickedByFlags) {
        return INCORRECT_COLOR;
      }
      // Fallback: check accumulative selection history
      const _qIdxHist = this.quizService.currentQuestionIndex ?? this.currentQuestionIndex();
      const selHistory = this.selectedOptionService._selectionHistory.get(_qIdxHist) ?? [];
      const optText = norm(b?.option?.text);
      if (optText && selHistory.some((s: SelectedOption) => norm(s?.text) === optText)) {
        return INCORRECT_COLOR;
      }
    }
    return undefined;
  }

  // Multi-answer data-driven gray: when the user has selected every
  // pristine-correct option for this question, every unselected
  // (incorrect) option goes gray. Mirrors the isDisabled() check so
  // visuals stay in lockstep without depending on the resolved-state map
  // or b.disabled flags being set in sync.
  private multiAnswerGray(): string | undefined {
    if (this.type() === 'multiple' && !this.binding()?.isSelected) {
      const _qIdx = this.quizService.currentQuestionIndex ?? this.currentQuestionIndex();
      if (this.quizService.isMultiAnswerComplete(_qIdx)) {
        // Read the signal directly so OnPush auto-tracks selection changes.
        const selectionsMapBg = this.selectedOptionService.selectedOptionsMapSig();
        const selectionsBg = selectionsMapBg.get(_qIdx) ?? [];
        const selectedTextsBg = new Set(
          selectionsBg.map((s: SelectedOption) => norm(s?.text)).filter((t: string) => !!t)
        );
        for (const t of this.selectedOptionService.uiSelectedTextsForQuestion(_qIdx)) {
          selectedTextsBg.add(t);
        }
        const myTextBg = norm(this.binding()?.option?.text);
        if (!selectedTextsBg.has(myTextBg)) {
          return DISABLED_COLOR;
        }
      }
      // Legacy flag fallback
      if (this.quizService.isQuestionResolved(_qIdx) && !this.isCurrentOptionCorrect()) {
        return DISABLED_COLOR;
      }
    }
    return undefined;
  }

  shouldShowFeedback(): boolean {
    // Interview Mode: correctness feedback is deferred until submission.
    if (this.feedbackPolicy.isDeferred()) return false;
    if (this.isTimerStamped()) return true;
    return this.shouldHighlightOption() || this.shouldShowCorrectOnTimeout();
  }

  onChanged(event: any): void {
    this._userHasClicked = true;
    // Latch _wasSelected immediately so shouldHighlightOption() returns
    // true on this CD pass — without this, the parent's async binding
    // update can race the render and the highlight misses intermittently.
    this._wasSelected = true;
    this.cdRef.markForCheck();
    this.optionUI.emit({
      optionId: this.optionId(),
      displayIndex: this.displayIndex(),
      kind: 'change',
      inputType: this.inputType,
      nativeEvent: event
    });
  }

  onContentClick(event: MouseEvent): void {
    event.stopPropagation();
    this._userHasClicked = true;
    this._wasSelected = true;
    this.cdRef.markForCheck();
    this.optionUI.emit({
      optionId: this.optionId(),
      displayIndex: this.displayIndex(),
      kind: 'contentClick',
      inputType: this.inputType,
      nativeEvent: event
    });
  }

  shouldHighlightOption(): boolean {
    // Catch in-place mutations from rehydrateUiFromState that bypass change
    // propagation (same object reference, so the binding signal input never
    // reports a change).
    // Only latch if (a) the user has actually clicked, or (b) the
    // binding's selection is confirmed by authoritative saved state.
    // Without the guard, transient b.isSelected from stale option.selected
    // data latches _wasSelected and bypasses the refresh guard below.
    if (this.binding()?.isSelected && !this._wasSelected) {
      if (this._userHasClicked || this.isSelectedForCurrentQuestion()) {
        this._wasSelected = true;
      }
    }

    // AUTO-REVEAL: persistent custom flag stamped by the auto-reveal block
    // (soc-answer-processing line ~840). Survives the post-click binding
    // spread AND the updateBindingSnapshots cssClasses rebuild that wipes
    // option.highlight-derived classes. Checked first so the green
    // highlight wins regardless of any downstream class/flag mutations.
    if (this.binding()?._autoRevealedCorrect === true ||
        this.binding()?.option?._autoRevealedCorrect === true) {
      return true;
    }
    // NOT an auto-reveal signal, despite what this comment used to claim — and
    // that claim cost a whole migration. Auto-reveal is the block above
    // (`_autoRevealedCorrect`), and it deliberately never sets this state (see
    // soc-answer-processing enterAutoRevealState), so this branch cannot be
    // reached BY auto-reveal.
    //
    // What it actually means: the question has been answered AND this option is
    // authorized correct, so keep it highlighted through binding rebuilds. The
    // cssClasses check below is the auto-reveal one — set by auto-reveal, kept
    // by the {...b} spread but wiped by updateBindingSnapshots.
    if (this.isCurrentOptionCorrect()) {
      const _qIdxAR = this.quizService.currentQuestionIndex ?? this.currentQuestionIndex();
      if (this.quizService.isQuestionResolved(_qIdxAR)) return true;
      if (this.binding()?.cssClasses?.['correct-option'] === true) return true;
    }

    // On refresh (no live click), ONLY trust authoritative saved
    // selection state — not binding flags which can be transiently
    // stale from processOptionBindings / hydrateOptions / setOptionBindingsIfChanged.
    if (!this._userHasClicked && !this._wasSelected) {
      // During live interaction, trust the binding's highlight flag
      // when explicitly false — prevents service-level false positives.
      if (this.binding()?.option?.highlight === false) return false;

      return this.isSelectedForCurrentQuestion();
    }

    if (this.type() === 'multiple') {
      // For multi-answer, trust the sharedOptionConfig as the final authority.
      // The config uses the durableSet (actual user clicks) to determine
      // highlight eligibility. Without this guard, transient binding state
      // from intermediate change-detection cycles can latch _wasSelected
      // on options the user never clicked (e.g. the 2nd correct answer).
      const cfg = this.sharedOptionConfig();
      if (cfg?.option && !cfg.option.highlight && !cfg.isOptionSelected) {
        return false;
      }
      return this.isOptionIndividuallySelected() || !!this.binding().option?.highlight ||
        this._wasSelected;
    }
    return this.binding().isSelected || !!this.binding().option?.highlight || this._wasSelected
      || this.isSelectedForCurrentQuestion();
  }

  // Computes the multi-answer disable state for this option from
  // pristine quiz data + currently saved selections, then writes it
  // onto b.disabled. Belt-and-suspenders alongside isDisabled():
  // legacy code paths read b.disabled directly, so keeping it in
  // sync ensures consistent state.
  private applyMultiAnswerDisableState(): void {
    try {
      if (!this.binding()?.option) return;
      const _qIdx = this.quizService.currentQuestionIndex ?? this.currentQuestionIndex();

      const liveQT =
        (this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[_qIdx]?.questionText
        ?? (this.quizService as any)?.questions?.[_qIdx]?.questionText;
      const pristineCorrectTexts =
        this.quizService.getPristineCorrectTextsForQuestion(liveQT);
      if (pristineCorrectTexts.size < 2) return;

      const selectionsMap = this.selectedOptionService.selectedOptionsMapSig();
      const selections = selectionsMap.get(_qIdx) ?? [];
      const selectedTexts = new Set(
        selections.map((s: SelectedOption) => norm(s?.text)).filter((t: string) => !!t)
      );
      const allPristineCorrectSelected =
        [...pristineCorrectTexts].every(t => selectedTexts.has(t));

      if (!allPristineCorrectSelected) return;

      const myText = norm(this.binding().option.text);
      if (!selectedTexts.has(myText)) {
        this.binding().disabled = true;
        if (this.binding().option) (this.binding().option as any).active = false;
      }
    } catch (err: unknown) { console.error('applyMultiAnswerDisableState failed:', err); }
  }


  private isTimerExpiredForThisQuestion(): boolean {
    return this.timerState.isExpiredForQuestion(
      this.currentQuestionIndex(),
      this._directTimerExpired,
      this._directTimerExpiredForIndex
    );
  }

  private get inputType(): 'radio' | 'checkbox' {
    return this.type() === 'multiple' ? 'checkbox' : 'radio';
  }

  private isCurrentOptionCorrect(): boolean {
    const qIdx = this.quizService.currentQuestionIndex ?? this.currentQuestionIndex();
    // The verdict service is the correctness authority; the helper falls back
    // to the local bank only for paths not yet migrated (see STAGE 9D).
    return isOptCorrect(this.binding(), this.quizService, qIdx, this.verdicts);
  }

  private isTimerStamped(): boolean {
    return this.timerState.isStamped(this.binding(), this.currentQuestionIndex());
  }

  private isStampedCorrect(): boolean {
    return this.timerState.isStampedCorrect(this.binding(), this.currentQuestionIndex());
  }

  private isOptionIndividuallySelected(): boolean {
    return (
      this.binding().isSelected ||
      this.binding().checked ||
      this.binding().option?.selected === true ||
      this.isSelectedForCurrentQuestion()
    );
  }

  private isSelectedForCurrentQuestion(): boolean {
    const qIdx = this.quizService.currentQuestionIndex ?? this.currentQuestionIndex();
    return isSelForCurrentQ(
      this.selectedOptionService,
      this.binding(),
      this.displayIndex(),
      qIdx
    );
  }

  /** Resolve the active question index. Delegates to the canonical
   *  helper on QuizService so all callers share identical semantics
   *  (input-first; service fallback; 0 when neither resolves). */
  private resolveQuestionIndex(): number {
    return this.quizService.resolveActiveQuestionIndex(this.currentQuestionIndex());
  }
}
