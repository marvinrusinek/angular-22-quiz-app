import { Service, inject } from '@angular/core';

import { SK_DOT_CONFIRMED } from '../../constants/session-keys';

import { Option } from '../../models/Option.model';
import { QuizQuestion } from '../../models/QuizQuestion.model';
import { SelectedOption } from '../../models/SelectedOption.model';

import { QuizPersistenceService } from '../state/quiz-persistence.service';
import { QuizService } from '../data/quiz.service';
import { QuizShuffleService } from './quiz-shuffle.service';
import { QuizStateService } from '../state/quizstate.service';
import { SelectedOptionService } from '../state/selectedoption.service';

import { isOptionCorrect } from '../../utils/is-option-correct';
import { resolveIsMultiAnswer } from '../../utils/question-type-authority';
import { norm } from '../../utils/text-norm';
import { swallow } from '../../utils/error-logging';

type DotStatus = 'correct' | 'wrong' | 'pending';
type DotResolved = 'correct' | 'wrong';

/** Threaded context for the scored-status decision branches of getQuestionStatus. */
interface ScoredDotCtx {
  index: number;
  quizId: string;
  currentQuestionIndex: number;
  dotStatusCache: Map<number, DotStatus>;
  pendingDotStatusOverrides: Map<number, DotResolved>;
  pendingOverrideStatus: DotResolved | undefined;
  previousCached: DotStatus | undefined;
  selections: Array<SelectedOption | Option>;
  questionHasLiveSessionState: boolean;
  scoringKey: any;
  hasScoredState: boolean;
  hasAuthoritativeCorrectState: boolean;
  evaluatedStatus: boolean | null;
  hasOptimisticCorrectSelection: boolean;
  localStatus: DotResolved | null;
  isLiveMultiAnswerQuestion: boolean;
  activeClickStatus: DotResolved | undefined;
}

/** Public input shape for getQuestionStatus. */
interface GetQuestionStatusParams {
  index: number;
  quizId: string;
  currentQuestionIndex: number;
  optionsToDisplay: Option[];
  currentQuestion: QuizQuestion | null;
  questionsArray: QuizQuestion[];
  dotStatusCache: Map<number, DotStatus>;
  pendingDotStatusOverrides: Map<number, DotResolved>;
  activeDotClickStatus: Map<number, DotResolved>;
  options?: { forceRecompute?: boolean };
}

/** Inputs to the scored-status phase (after the early exits). */
interface ScoredDotParams {
  index: number;
  quizId: string;
  currentQuestionIndex: number;
  optionsToDisplay: Option[];
  currentQuestion: QuizQuestion | null;
  questionsArray: QuizQuestion[];
  selections: Array<SelectedOption | Option>;
  questionHasLiveSessionState: boolean;
  pendingOverrideStatus: DotResolved | undefined;
  previousCached: DotStatus | undefined;
  dotStatusCache: Map<number, DotStatus>;
  pendingDotStatusOverrides: Map<number, DotResolved>;
  activeDotClickStatus: Map<number, DotResolved>;
}

/**
 * Manages dot status computation, selection evaluation, and question
 * status determination for the quiz pagination dots.
 * Extracted from QuizComponent to reduce its size.
 */
@Service()
export class QuizDotStatusService {

  // ── injects ─────────────────────────────────────────────────────
  private persistence = inject(QuizPersistenceService);
  private quizService = inject(QuizService);
  private quizShuffleService = inject(QuizShuffleService);
  private quizStateService = inject(QuizStateService);
  private selectedOptionService = inject(SelectedOptionService);

  // ── properties ──────────────────────────────────────────────────
  dotStatusCache = new Map<number, 'correct' | 'wrong' | 'pending'>();
  pendingDotStatusOverrides = new Map<number, 'correct' | 'wrong'>();
  activeDotClickStatus = new Map<number, 'correct' | 'wrong'>();
  timerExpiredUnanswered = new Set<number>();
  // Durable record of questions whose timer expired (keyed by the same
  // CodelabQuizContentComponent display index as timedOutIdxSubject). Unlike
  // timerExpiredUnanswered it is NEVER deleted by updateDotStatus, and unlike
  // timedOutIdxSubject it is NOT reset on navigation — so the heading keeps the
  // FET on revisit for ANY timed-out question. Cleared only on full reset.
  timedOutFetForced = new Set<number>();

  // ═══════════════════════════════════════════════════════════════
  // STATE MAP HELPERS
  // ═══════════════════════════════════════════════════════════════

  clearAllMaps(): void {
    this.dotStatusCache.clear();
    this.pendingDotStatusOverrides.clear();
    this.activeDotClickStatus.clear();
    this.timerExpiredUnanswered.clear();
    this.timedOutFetForced.clear();
  }

  clearForIndex(index: number): void {
    this.activeDotClickStatus.delete(index);
    this.pendingDotStatusOverrides.delete(index);
    this.dotStatusCache.delete(index);
  }

  // ═══════════════════════════════════════════════════════════════
  // SCORING KEY HELPERS
  // ═══════════════════════════════════════════════════════════════

  getScoringKey(quizId: string, index: number): number {
    const effectiveQuizId = quizId
      || this.quizService.quizId
      || localStorage.getItem('lastQuizId')
      || '';
    if (this.quizService.isShuffleEnabled() && effectiveQuizId) {
      const originalIndex = this.quizShuffleService.toOriginalIndex(effectiveQuizId, index);
      if (typeof originalIndex === 'number' && originalIndex >= 0) {
        return originalIndex;
      }
    }
    return index;
  }

  getCandidateQuestionIndices(quizId: string, index: number): number[] {
    const scoringKey = this.getScoringKey(quizId, index);
    return Array.from(new Set([index, scoringKey]));
  }

  // ═══════════════════════════════════════════════════════════════
  // QUESTION LOOKUP
  // ═══════════════════════════════════════════════════════════════

  getQuestionForIndex(index: number, questionsArray: QuizQuestion[]): QuizQuestion | null {
    return this.quizService.questions?.[index] ||
      questionsArray?.[index] ||
      this.quizService.activeQuiz?.questions?.[index] ||
      null;
  }

  // ═══════════════════════════════════════════════════════════════
  // SELECTION MATCHING
  // ═══════════════════════════════════════════════════════════════

  selectionMatchesOption(
    selection: Partial<SelectedOption> | null | undefined,
    option: Partial<Option> | null | undefined,
    optionIndex?: number
  ): boolean {
    if (!selection || !option) return false;

    const normalize = (value: unknown): string => norm(value);
    const selectionId = String(selection.optionId ?? '').trim();
    const optionId = String(option.optionId ?? '').trim();

    if (selectionId !== '' && optionId !== '' && selectionId === optionId) {
      return true;
    }

    const selectionText = normalize(selection.text);
    const optionText = normalize(option.text);
    if (selectionText !== '' && optionText !== '' && selectionText === optionText) {
      return true;
    }

    const selectionDisplayIndex = Number(
      (selection as any)?.displayIndex ?? (selection as any)?.index ?? -1
    );
    return Number.isInteger(optionIndex) && selectionDisplayIndex === optionIndex;
  }

  // ═══════════════════════════════════════════════════════════════
  // CORRECT OPTION RESOLUTION
  // ═══════════════════════════════════════════════════════════════

  getResolvedCorrectOptionEntries(
    question: QuizQuestion | null | undefined,
    fallbackOptions: Option[] = []
  ): Array<{ option: Option; index: number }> {
    const options = Array.isArray(question?.options) && question!.options.length > 0
      ? question!.options : fallbackOptions;

    if (!Array.isArray(options) || options.length === 0) return [];

    const correctIds = new Set<number>();
    const correctTexts = new Set<string>();

    if (Array.isArray((question as any)?.answer)) {
      for (const answer of (question as any).answer) {
        if (!answer) continue;

        const id = Number(answer.optionId);
        if (!Number.isNaN(id)) correctIds.add(id);

        const text = norm(answer.text);
        if (text) correctTexts.add(text);
      }
    }

    const resolvedFromAnswers = options
      .map((opt: Option, index: number) => ({ option: opt, index }))
      .filter(({ option }) => {
        const id = Number(option?.optionId);
        const text = norm(option?.text);

        return (!Number.isNaN(id) && correctIds.has(id)) || (!!text && correctTexts.has(text));
      });

    if (resolvedFromAnswers.length > 0) return resolvedFromAnswers;

    return options
      .map((opt: Option, index: number) => ({ option: opt, index }))
      .filter(({ option }) => isOptionCorrect(option));
  }

  getResolvedCorrectOptions(
    question: QuizQuestion | null | undefined,
    fallbackOptions: Option[] = []
  ): Option[] {
    return this.getResolvedCorrectOptionEntries(question, fallbackOptions)
      .map(({ option }) => option);
  }

  matchesAnyCorrectOption(
    selection: Partial<SelectedOption> | null | undefined,
    question: QuizQuestion | null | undefined,
    fallbackOptions: Option[] = []
  ): boolean {
    return this.getResolvedCorrectOptionEntries(question, fallbackOptions)
      .some(({ option, index }) => this.selectionMatchesOption(selection, option, index));
  }

  // ═══════════════════════════════════════════════════════════════
  // OPTIMISTIC CORRECT SELECTION
  // ═══════════════════════════════════════════════════════════════

  hasOptimisticCorrectSelection(params: {
    index: number;
    selections: SelectedOption[];
    currentQuestionIndex: number;
    optionsToDisplay: Option[];
    currentQuestion: QuizQuestion | null;
    questionsArray: QuizQuestion[];
  }): boolean {
    const { index, selections, currentQuestionIndex, optionsToDisplay, currentQuestion, questionsArray } = params;
    const question = this.getQuestionForIndex(index, questionsArray);
    const fallbackOptions = this.getFallbackOptions(index, currentQuestionIndex, optionsToDisplay, currentQuestion);

    if (selections.length === 0) return false;

    const correctOptionEntries = this.getResolvedCorrectOptionEntries(question, fallbackOptions);

    if (correctOptionEntries.length <= 1) return false;

    const hasIncorrectSelection = selections.some((selection) =>
      !this.matchesAnyCorrectOption(selection, question, fallbackOptions)
    );

    if (hasIncorrectSelection) return false;

    const matchedCorrectSelections = selections.filter((selection) =>
      this.matchesAnyCorrectOption(selection, question, fallbackOptions)
    );

    return matchedCorrectSelections.length === correctOptionEntries.length;
  }

  // ═══════════════════════════════════════════════════════════════
  // SELECTION CORRECTNESS EVALUATION
  // ═══════════════════════════════════════════════════════════════

  evaluateSelectionCorrectness(params: {
    index: number;
    selections: SelectedOption[];
    currentQuestionIndex: number;
    optionsToDisplay: Option[];
    currentQuestion: QuizQuestion | null;
    questionsArray: QuizQuestion[];
  }): boolean | null {
    const { index, selections, currentQuestionIndex, optionsToDisplay, currentQuestion, questionsArray } = params;
    const question = this.getQuestionForIndex(index, questionsArray);
    const fallbackOptions = this.getFallbackOptions(index, currentQuestionIndex, optionsToDisplay, currentQuestion);

    if (
      (!question || !Array.isArray(question.options) || question.options.length === 0)
      && fallbackOptions.length === 0
    ) return null;

    const correctOptionEntries = this.getResolvedCorrectOptionEntries(question, fallbackOptions);
    const correctOptions = correctOptionEntries.map(({ option }) => option);
    // DECLARED TYPE WINS. `correctOptions.length > 1` used to be an equal arm
    // of the OR, so the local answer key could promote a declared single-answer
    // question to multiple and switch this evaluator to the all-correct-
    // selected completeness rule.
    //
    // The declared type is read from the DISPLAYED question: getQuestionForIndex
    // above indexes the CANONICAL array with what is a display index, which is
    // exactly the identity defect fixed in 95a3d3cc. Correctness still flows
    // through the existing lookup — only the type decision is re-anchored here.
    const isMultipleAnswerQuestion = resolveIsMultiAnswer(
      this.quizService.getDisplayedQuestion?.(index) ?? question,
      correctOptions.length > 1
    );

    if (correctOptions.length === 0 || selections.length === 0) return null;

    const matchedCorrectSelections = selections.filter((selection) =>
      correctOptionEntries.some(({ option, index: optionIndex }) =>
        this.selectionMatchesOption(selection, option, optionIndex)
      )
    );

    const incorrectSelections = selections.filter((selection) =>
      !correctOptionEntries.some(({ option, index: optionIndex }) =>
        this.selectionMatchesOption(selection, option, optionIndex)
      )
    );

    if (matchedCorrectSelections.length === 0 && incorrectSelections.length === 0) {
      return null;
    }

    if (isMultipleAnswerQuestion) {
      if (incorrectSelections.length > 0) return false;

      return matchedCorrectSelections.length === correctOptionEntries.length;
    }

    if (incorrectSelections.length > 0) return false;

    return matchedCorrectSelections.length > 0 ? true : null;
  }

  // ═══════════════════════════════════════════════════════════════
  // SELECTION RETRIEVAL
  // ═══════════════════════════════════════════════════════════════

  getSelectionsForQuestion(params: {
    index: number;
    currentQuestionIndex: number;
    optionsToDisplay: Option[];
    currentQuestion: QuizQuestion | null;
    questionsArray: QuizQuestion[];
  }): SelectedOption[] {
    const { index, currentQuestionIndex, optionsToDisplay, currentQuestion, questionsArray } = params;
    const question = this.quizService.questions?.[index] ||
      questionsArray?.[index] ||
      this.quizService.activeQuiz?.questions?.[index];
    const currentQuestionOptions = index === currentQuestionIndex
      ? ((Array.isArray(optionsToDisplay) && optionsToDisplay.length > 0)
          ? optionsToDisplay
          : (Array.isArray(currentQuestion?.options) ? currentQuestion!.options as Option[] : []))
      : [];
    const referenceOptions = Array.isArray(question?.options) && question!.options.length > 0
      ? question!.options
      : currentQuestionOptions;

    const sets = this.buildOptionMatchSets(referenceOptions);

    // Source 1: the currently-displayed options for the active question
    if (index === currentQuestionIndex && currentQuestionOptions.length > 0) {
      const displayedSelections = this.collectDisplayedSelections(currentQuestionOptions, index);
      if (displayedSelections.length > 0) {
        return this.pickRelevantSelections(displayedSelections, index, sets);
      }
    }

    // Source 2: SelectedOptionService map
    const serviceSelection = this.selectedOptionService?.selectedOptionsMap?.get(index);
    if (Array.isArray(serviceSelection) && serviceSelection.length > 0) {
      return this.pickRelevantSelections(serviceSelection, index, sets);
    }

    // Source 3: QuizService map
    const quizSelection = this.quizService?.selectedOptionsMap?.get(index);
    if (Array.isArray(quizSelection) && quizSelection.length > 0) {
      return this.pickRelevantSelections(quizSelection as SelectedOption[], index, sets);
    }

    // Source 4: reconstruct from stored userAnswers (revisited questions only)
    if (index !== currentQuestionIndex) {
      const reconstructed = this.reconstructStoredSelections(index, question);
      if (reconstructed.length > 0) {
        return reconstructed;
      }
    }

    return [];
  }

  private isSelectionActive(selection: SelectedOption): boolean {
    if (!selection) return false;

    return selection.selected !== false &&
      (selection as any)?.checked !== false &&
      (selection as any)?.isSelected !== false &&
      (selection as any)?.active !== false;
  }

  private buildOptionMatchSets(referenceOptions: Option[]): {
    optionIdSet: Set<string>;
    optionTextSet: Set<string>;
    optionIndexSet: Set<number>;
  } {
    const optionIdSet = new Set(
      referenceOptions
        .map((opt: Option, optIndex: number) => {
          const rawId = opt?.optionId;
          if (rawId !== undefined && rawId !== null && String(rawId).trim() !== '') {
            return String(rawId).trim();
          }
          return String(optIndex);
        })
    );
    const optionTextSet = new Set(
      referenceOptions.map((opt: Option) => norm(opt?.text)).filter(Boolean)
    );
    const optionIndexSet = new Set(
      referenceOptions.map((_opt: Option, optIndex: number) => optIndex)
    );
    return { optionIdSet, optionTextSet, optionIndexSet };
  }

  private pickRelevantSelections(
    selections: SelectedOption[],
    index: number,
    sets: { optionIdSet: Set<string>; optionTextSet: Set<string>; optionIndexSet: Set<number> }
  ): SelectedOption[] {
    if (!Array.isArray(selections) || selections.length === 0) return [];

    const activeSelections = selections.filter((s) => this.isSelectionActive(s));
    if (activeSelections.length === 0) return [];

    const exactQuestionSelections = activeSelections.filter(
      (selection: SelectedOption) => selection?.questionIndex === index
    );
    if (exactQuestionSelections.length > 0) return exactQuestionSelections;

    const matchedSelections = activeSelections.filter((selection: SelectedOption) => {
      const selectionId = String(selection?.optionId ?? '').trim();
      const selectionText = norm(selection?.text);
      const selectionDisplayIndex = Number(
        (selection as any)?.displayIndex ?? (selection as any)?.index ?? -1
      );

      return (
        (selectionId !== '' && sets.optionIdSet.has(selectionId)) ||
        (selectionText !== '' && sets.optionTextSet.has(selectionText)) ||
        sets.optionIndexSet.has(selectionDisplayIndex)
      );
    });

    return matchedSelections.length > 0 ? matchedSelections : activeSelections;
  }

  private collectDisplayedSelections(currentQuestionOptions: Option[], index: number): SelectedOption[] {
    return currentQuestionOptions
      .map((option: Option, optionIndex: number) => ({ option, optionIndex }))
      .filter(({ option }) => this.isSelectionActive(option as SelectedOption))
      .map(({ option, optionIndex }) => ({
        ...(option as SelectedOption),
        optionId: option?.optionId ?? optionIndex,
        questionIndex: index,
        displayIndex: Number(
          (option as any)?.displayIndex ?? (option as any)?.index ?? optionIndex
        ),
        selected: true
      } as SelectedOption));
  }

  private reconstructStoredSelections(index: number, question: QuizQuestion | undefined): SelectedOption[] {
    const storedAnswerIds = Array.isArray(this.quizService?.userAnswers?.[index])
      ? (this.quizService.userAnswers[index] as number[]) : [];
    if (!(storedAnswerIds.length > 0 && Array.isArray(question?.options) && question!.options.length > 0)) {
      return [];
    }
    return storedAnswerIds
      .map((answerId: number) => {
        const directMatch = question!.options.find(
          (opt: Option) => String(opt?.optionId ?? '') === String(answerId)
        );
        if (directMatch) {
          return {
            ...directMatch,
            optionId: directMatch.optionId ?? answerId,
            questionIndex: index,
            selected: true
          } as SelectedOption;
        }

        if (Number.isInteger(answerId) && answerId >= 0 && answerId < question!.options.length) {
          return {
            ...question!.options[answerId],
            optionId: question!.options[answerId]?.optionId ?? answerId,
            questionIndex: index,
            displayIndex: answerId,
            selected: true
          } as SelectedOption;
        }

        return null;
      })
      .filter((selection): selection is SelectedOption => !!selection);
  }

  // ═══════════════════════════════════════════════════════════════
  // LIVE SESSION STATE CHECK
  // ═══════════════════════════════════════════════════════════════

  hasLiveSessionStateForQuestion(quizId: string, index: number): boolean {
    const selectedViaService = this.selectedOptionService?.selectedOptionsMap?.get(index);
    if (Array.isArray(selectedViaService) && selectedViaService.length > 0) {
      return true;
    }

    const selectedViaQuiz = this.quizService?.selectedOptionsMap?.get(index);
    if (Array.isArray(selectedViaQuiz) && selectedViaQuiz.length > 0) {
      return true;
    }

    const scoringKey = this.getScoringKey(quizId, index);
    const score = this.quizService?.questionCorrectness?.get(scoringKey);
    if (score === true || score === false) return true;

    const answers = this.quizService?.userAnswers?.[index];
    return Array.isArray(answers) && answers.length > 0;
  }

  // ═══════════════════════════════════════════════════════════════
  // QUIZ FRESH CHECK
  // ═══════════════════════════════════════════════════════════════

  isQuizFreshAtQuestionOne(currentQuestionIndex: number): boolean {
    if (currentQuestionIndex !== 0) return false;

    const hasSelectionsInSelectedOptionService =
      (this.selectedOptionService?.selectedOptionsMap?.size ?? 0) > 0
      || this.selectedOptionService?.hasRefreshBackup
      || (this.selectedOptionService?.clickConfirmedDotStatus?.size ?? 0) > 0;
    const hasSelectionsInQuizService =
      (this.quizService?.selectedOptionsMap?.size ?? 0) > 0;
    const hasScoredQuestions =
      (this.quizService?.questionCorrectness?.size ?? 0) > 0;
    const hasStoredUserAnswers =
      Array.isArray(this.quizService?.userAnswers) &&
      this.quizService.userAnswers.some((answers: unknown) =>
        Array.isArray(answers) && answers.length > 0
      );
    const hasStateServiceActivity =
      (this.quizStateService?._answeredQuestionIndices?.size ?? 0) > 0 ||
      (this.quizStateService?._hasUserInteracted?.size ?? 0) > 0;

    return !hasSelectionsInSelectedOptionService &&
      !hasSelectionsInQuizService &&
      !hasScoredQuestions &&
      !hasStoredUserAnswers &&
      !hasStateServiceActivity;
  }

  // ═══════════════════════════════════════════════════════════════
  // GET QUESTION STATUS (core dot status computation)
  // ═══════════════════════════════════════════════════════════════

  getQuestionStatusSimple(params: {
    index: number;
    quizId: string;
    currentQuestionIndex: number;
    optionsToDisplay: Option[];
    currentQuestion: QuizQuestion | null;
    questionsArray: QuizQuestion[];
    options?: { forceRecompute?: boolean };
  }): 'correct' | 'wrong' | 'pending' {
    return this.getQuestionStatus({
      ...params,
      dotStatusCache: this.dotStatusCache,
      pendingDotStatusOverrides: this.pendingDotStatusOverrides,
      activeDotClickStatus: this.activeDotClickStatus
    });
  }

  getDotClassSimple(params: {
    index: number;
    quizId: string;
    currentQuestionIndex: number;
    optionsToDisplay: Option[];
    currentQuestion: QuizQuestion | null;
    questionsArray: QuizQuestion[];
  }): string {
    return this.getDotClass({
      ...params,
      dotStatusCache: this.dotStatusCache,
      pendingDotStatusOverrides: this.pendingDotStatusOverrides,
      activeDotClickStatus: this.activeDotClickStatus,
      timerExpiredUnanswered: this.timerExpiredUnanswered
    });
  }

  getQuestionStatus(params: GetQuestionStatusParams): DotStatus {
    const {
      index, quizId, currentQuestionIndex, optionsToDisplay, currentQuestion,
      questionsArray, dotStatusCache, pendingDotStatusOverrides, activeDotClickStatus,
    } = params;
    const forceRecompute = !!params.options?.forceRecompute;

    // Refresh-restore short-circuit + fresh-at-Q1 reset.
    const early = this.tryEarlyDotExits(index, currentQuestionIndex, dotStatusCache, pendingDotStatusOverrides, activeDotClickStatus);
    if (early) return early;

    const {
      pendingOverrideStatus, previousCached, hasCachedStatus, selections, questionHasLiveSessionState,
    } = this.deriveDotState(params);

    const r2 = this.tryCachedShortCircuit({
      index, currentQuestionIndex, forceRecompute, dotStatusCache,
      hasCachedStatus, questionHasLiveSessionState, selections,
    });
    if (r2) return r2;

    const r3 = this.tryEarlyAuthoritativeNonCurrent(index, quizId, currentQuestionIndex, dotStatusCache);
    if (r3) return r3;

    if (index === currentQuestionIndex && !questionHasLiveSessionState && selections.length === 0) {
      return this.resolveCurrentNoSelection(index, quizId, previousCached, dotStatusCache);
    }

    return this.resolveScoredDotStatus({
      index, quizId, currentQuestionIndex, optionsToDisplay, currentQuestion, questionsArray,
      selections, questionHasLiveSessionState, pendingOverrideStatus, previousCached,
      dotStatusCache, pendingDotStatusOverrides, activeDotClickStatus,
    });
  }

  /** Per-question derived state used by the cached/no-selection/scored phases. Extracted verbatim. */
  private deriveDotState(p: GetQuestionStatusParams): {
    pendingOverrideStatus: DotResolved | undefined;
    previousCached: DotStatus | undefined;
    hasCachedStatus: boolean;
    selections: Array<SelectedOption | Option>;
    questionHasLiveSessionState: boolean;
  } {
    const { index, quizId, currentQuestionIndex, optionsToDisplay, currentQuestion, questionsArray, dotStatusCache, pendingDotStatusOverrides } = p;
    const selectionParams = { index, currentQuestionIndex, optionsToDisplay, currentQuestion, questionsArray };
    return {
      pendingOverrideStatus: pendingDotStatusOverrides.get(index),
      previousCached: dotStatusCache.get(index),
      hasCachedStatus: dotStatusCache.has(index),
      selections: this.getSelectionsForQuestion(selectionParams),
      questionHasLiveSessionState: this.hasLiveSessionStateForQuestion(quizId, index),
    };
  }

  /** Pre-derivation early exits: refresh-restore short-circuit, then fresh-at-Q1 -> pending. Extracted verbatim. */
  private tryEarlyDotExits(
    index: number,
    currentQuestionIndex: number,
    dotStatusCache: Map<number, DotStatus>,
    pendingDotStatusOverrides: Map<number, DotResolved>,
    activeDotClickStatus: Map<number, DotResolved>
  ): DotStatus | null {
    const r1 = this.tryConfirmedOnRefresh(index, pendingDotStatusOverrides, activeDotClickStatus, dotStatusCache);
    if (r1) return r1;

    if (this.isQuizFreshAtQuestionOne(currentQuestionIndex)) {
      dotStatusCache.set(index, 'pending');
      return 'pending';
    }
    return null;
  }

  /** Refresh-restore: confirmed dot color when no pending/active override exists. Extracted verbatim. */
  private tryConfirmedOnRefresh(
    index: number,
    pendingDotStatusOverrides: Map<number, DotResolved>,
    activeDotClickStatus: Map<number, DotResolved>,
    dotStatusCache: Map<number, DotStatus>
  ): DotStatus | null {
    const confirmedForIndex = this.selectedOptionService.clickConfirmedDotStatus.get(index);
    if (
      (confirmedForIndex === 'correct' || confirmedForIndex === 'wrong') &&
      !pendingDotStatusOverrides.has(index) &&
      !activeDotClickStatus.has(index)
    ) {
      dotStatusCache.set(index, confirmedForIndex);
      return confirmedForIndex;
    }
    return null;
  }

  /** Short-circuit on a usable cached status (unless forceRecompute). Extracted verbatim. */
  private tryCachedShortCircuit(p: {
    index: number;
    currentQuestionIndex: number;
    forceRecompute: boolean;
    dotStatusCache: Map<number, DotStatus>;
    hasCachedStatus: boolean;
    questionHasLiveSessionState: boolean;
    selections: Array<SelectedOption | Option>;
  }): DotStatus | null {
    if (!p.hasCachedStatus) return null;
    const cached = p.dotStatusCache.get(p.index)!;
    const isCurrentQuestion = p.index === p.currentQuestionIndex;

    if (!p.forceRecompute && !isCurrentQuestion && cached === 'correct') {
      return cached;
    }
    if (
      !p.forceRecompute &&
      !isCurrentQuestion &&
      cached === 'pending' &&
      !p.questionHasLiveSessionState &&
      p.selections.length === 0
    ) {
      return cached;
    }
    if (!p.forceRecompute && isCurrentQuestion && cached === 'pending') {
      return cached;
    }
    return null;
  }

  /** Early authoritative-correct check for non-current questions. Extracted verbatim. */
  private tryEarlyAuthoritativeNonCurrent(
    index: number,
    quizId: string,
    currentQuestionIndex: number,
    dotStatusCache: Map<number, DotStatus>
  ): DotStatus | null {
    if (index !== currentQuestionIndex) {
      const earlyScoringKey = this.getScoringKey(quizId, index);
      const earlyScored = this.quizService.questionCorrectness.get(earlyScoringKey);
      if (earlyScored === true) {
        dotStatusCache.set(index, 'correct');
        return 'correct';
      }
    }
    return null;
  }

  /**
   * Current question with no live state and no selections: restore from cache,
   * persisted dot status, confirmed status, then sessionStorage; else pending.
   * Extracted verbatim.
   */
  private resolveCurrentNoSelection(
    index: number,
    quizId: string,
    previousCached: DotStatus | undefined,
    dotStatusCache: Map<number, DotStatus>
  ): DotStatus {
    if (previousCached === 'correct' || previousCached === 'wrong') {
      dotStatusCache.set(index, previousCached);
      return previousCached;
    }

    const localStatus = this.persistence.getPersistedDotStatus(quizId, index);
    if (localStatus === 'correct' || localStatus === 'wrong') {
      dotStatusCache.set(index, localStatus);
      return localStatus;
    }

    const restored = this.restoreDotFromConfirmedOrSession(index, quizId, dotStatusCache);
    if (restored) return restored;

    dotStatusCache.set(index, 'pending');
    return 'pending';
  }

  /**
   * Restore a confirmed dot status (cache + persist) from clickConfirmedDotStatus,
   * then directly from sessionStorage; null when neither has a value. Extracted verbatim.
   */
  private restoreDotFromConfirmedOrSession(
    index: number,
    quizId: string,
    dotStatusCache: Map<number, DotStatus>
  ): DotResolved | null {
    const confirmedStatus = this.selectedOptionService.clickConfirmedDotStatus.get(index);
    if (confirmedStatus === 'correct' || confirmedStatus === 'wrong') {
      dotStatusCache.set(index, confirmedStatus);
      this.persistence.setPersistedDotStatus(quizId, index, confirmedStatus);
      return confirmedStatus;
    }

    try {
      const sessionVal = sessionStorage.getItem(SK_DOT_CONFIRMED + index);
      if (sessionVal === 'correct' || sessionVal === 'wrong') {
        dotStatusCache.set(index, sessionVal);
        this.persistence.setPersistedDotStatus(quizId, index, sessionVal);
        return sessionVal;
      }
    } catch (err: unknown) { swallow('quiz-dot-status.service.ts', err); }
    return null;
  }

  /**
   * Build the scoring/evaluation context, then run the decision branches in
   * order: overrides -> selection-based -> authoritative/eval fallbacks.
   * Extracted verbatim.
   */
  private resolveScoredDotStatus(p: ScoredDotParams): DotStatus {
    const ctx = this.buildScoredDotCtx(p);
    return this.resolveOverrideDotStatus(ctx)
      ?? this.resolveSelectionDotStatus(ctx)
      ?? this.resolveAuthoritativeDotStatus(ctx)
      ?? this.resolveUnscoredFallbackDotStatus(ctx);
  }

  /** Compute the scoring/evaluation context for the decision branches. Extracted verbatim. */
  private buildScoredDotCtx(p: ScoredDotParams): ScoredDotCtx {
    const {
      index, quizId, currentQuestionIndex, optionsToDisplay, currentQuestion, questionsArray,
      selections, questionHasLiveSessionState, pendingOverrideStatus, previousCached,
      dotStatusCache, pendingDotStatusOverrides, activeDotClickStatus,
    } = p;

    const { scoringKey, hasScoredState, hasAuthoritativeCorrectState } = this.getScoredStateFlags(quizId, index);

    const evalParams = { index, selections, currentQuestionIndex, optionsToDisplay, currentQuestion, questionsArray };
    const evaluatedStatus = selections.length > 0
      ? this.evaluateSelectionCorrectness(evalParams)
      : null;
    const hasOptimisticCorrectSelection = selections.length > 0 &&
      this.hasOptimisticCorrectSelection({ ...evalParams, selections });

    const localStatus = this.persistence.getPersistedDotStatus(quizId, index);
    const isLiveMultiAnswerQuestion = this.computeIsLiveMultiAnswer(p);
    const activeClickStatus = activeDotClickStatus.get(index);

    return {
      index, quizId, currentQuestionIndex, dotStatusCache, pendingDotStatusOverrides,
      pendingOverrideStatus, previousCached, selections, questionHasLiveSessionState,
      scoringKey, hasScoredState, hasAuthoritativeCorrectState, evaluatedStatus,
      hasOptimisticCorrectSelection, localStatus, isLiveMultiAnswerQuestion, activeClickStatus,
    };
  }

  /** Scoring flags from questionCorrectness for this index. Extracted verbatim. */
  private getScoredStateFlags(quizId: string, index: number): {
    scoringKey: any; hasScoredState: boolean; hasAuthoritativeCorrectState: boolean;
  } {
    const scoringKey = this.getScoringKey(quizId, index);
    const persistedScoredValues = [this.quizService.questionCorrectness.get(scoringKey)]
      .filter((value): value is boolean => value === true || value === false);
    return {
      scoringKey,
      hasScoredState: persistedScoredValues.length > 0,
      hasAuthoritativeCorrectState: persistedScoredValues.includes(true),
    };
  }

  /** Is this the live (current, interacted) multi-answer question? Extracted verbatim. */
  private computeIsLiveMultiAnswer(p: ScoredDotParams): boolean {
    const { index, currentQuestionIndex, optionsToDisplay, currentQuestion, questionsArray, selections, questionHasLiveSessionState } = p;
    const question = this.getQuestionForIndex(index, questionsArray);
    const fallbackOptions = this.getFallbackOptions(index, currentQuestionIndex, optionsToDisplay, currentQuestion);
    const resolvedCorrectOptionCount = this.getResolvedCorrectOptionEntries(question, fallbackOptions).length;
    // DECLARED TYPE WINS — same OR-promotion defect as evaluateSelectionCorrectness.
    return index === currentQuestionIndex &&
      (questionHasLiveSessionState || selections.length > 0) &&
      resolveIsMultiAnswer(
        this.quizService.getDisplayedQuestion?.(index) ?? question,
        resolvedCorrectOptionCount > 1
      );
  }

  /** setPersistedDotStatus + cache + return. Extracted (common to the scored branches). */
  private persistAndCache(c: ScoredDotCtx, status: DotResolved): DotResolved {
    this.persistence.setPersistedDotStatus(c.quizId, c.index, status);
    c.dotStatusCache.set(c.index, status);
    return status;
  }

  /** Cache + return (no persistence write). Extracted (common to the scored branches). */
  private cacheAndReturn(c: ScoredDotCtx, status: DotStatus): DotStatus {
    c.dotStatusCache.set(c.index, status);
    return status;
  }

  /** When the last click for this index was confirmed correct, persist+cache+return 'correct'. Extracted verbatim. */
  private tryClickConfirmedCorrect(c: ScoredDotCtx): DotResolved | null {
    const clickConfirmed = this.selectedOptionService.clickConfirmedDotStatus.get(c.index);
    if (clickConfirmed === 'correct') {
      return this.persistAndCache(c, 'correct');
    }
    return null;
  }

  /** Live-multi active/pending and current-question pending overrides. Extracted verbatim. */
  private resolveOverrideDotStatus(c: ScoredDotCtx): DotStatus | null {
    if (c.isLiveMultiAnswerQuestion && c.activeClickStatus) {
      this.persistence.setPersistedDotStatus(c.quizId, c.index, c.activeClickStatus);
      c.pendingDotStatusOverrides.set(c.index, c.activeClickStatus);
      c.dotStatusCache.set(c.index, c.activeClickStatus);
      return c.activeClickStatus;
    }
    if (c.isLiveMultiAnswerQuestion && c.pendingOverrideStatus) {
      return this.persistAndCache(c, c.pendingOverrideStatus);
    }
    if (c.pendingOverrideStatus && c.index === c.currentQuestionIndex) {
      return this.persistAndCache(c, c.pendingOverrideStatus);
    }
    return null;
  }

  /** Selection-driven branches: optimistic-correct, local-wrong, live-multi/non-current correct, eval-false. Extracted verbatim. */
  private resolveSelectionDotStatus(c: ScoredDotCtx): DotStatus | null {
    if (c.hasOptimisticCorrectSelection) {
      return this.persistAndCache(c, 'correct');
    }

    if (c.localStatus === 'wrong' && c.evaluatedStatus !== true && !c.hasAuthoritativeCorrectState) {
      // Don't return 'wrong' if the most recent click was correct.
      return this.tryClickConfirmedCorrect(c) ?? this.cacheAndReturn(c, 'wrong');
    }

    if (c.index === c.currentQuestionIndex && c.isLiveMultiAnswerQuestion && c.localStatus === 'correct') {
      return this.cacheAndReturn(c, 'correct');
    }

    if (
      c.index !== c.currentQuestionIndex &&
      c.localStatus === 'correct' &&
      (c.questionHasLiveSessionState || c.selections.length > 0)
    ) {
      return this.cacheAndReturn(c, 'correct');
    }

    if (
      c.index === c.currentQuestionIndex &&
      c.evaluatedStatus === false &&
      (c.questionHasLiveSessionState || c.selections.length > 0)
    ) {
      return this.resolveCurrentEvalFalse(c);
    }
    return null;
  }

  /**
   * Current question with eval-false: trust the per-click confirmed / last-clicked
   * correct over the aggregate evaluation; otherwise 'wrong'. Extracted verbatim.
   */
  private resolveCurrentEvalFalse(c: ScoredDotCtx): DotResolved {
    const confirmed = this.tryClickConfirmedCorrect(c);
    if (confirmed) return confirmed;
    const lastClickedCorrect = this.selectedOptionService.lastClickedCorrectByQuestion.get(c.index);
    if (lastClickedCorrect === true) {
      return this.persistAndCache(c, 'correct');
    }
    return this.persistAndCache(c, 'wrong');
  }

  /**
   * Authoritative-correct, evaluated, and non-current persisted branches; returns
   * null to fall through to the unscored fallbacks. Extracted verbatim.
   */
  private resolveAuthoritativeDotStatus(c: ScoredDotCtx): DotStatus | null {
    if (c.hasAuthoritativeCorrectState) {
      return this.persistAndCache(c, 'correct');
    }
    if (c.evaluatedStatus === true || c.evaluatedStatus === false) {
      return this.persistAndCache(c, c.evaluatedStatus ? 'correct' : 'wrong');
    }
    if (c.index !== c.currentQuestionIndex && c.localStatus === 'correct') {
      return this.cacheAndReturn(c, c.localStatus);
    }
    if (c.index !== c.currentQuestionIndex) {
      const persisted = this.quizService.questionCorrectness.get(c.scoringKey);
      if (persisted === true || persisted === false) {
        return this.persistAndCache(c, persisted ? 'correct' : 'wrong');
      }
    }
    return null;
  }

  /**
   * Unscored fallbacks: a no-eval restore, a non-current local-correct, a final
   * eval pass, then clickConfirmedDotStatus / sessionStorage, then 'pending'.
   * Always returns. Extracted verbatim.
   */
  private resolveUnscoredFallbackDotStatus(c: ScoredDotCtx): DotStatus {
    if (!c.hasScoredState && c.evaluatedStatus === null) {
      return this.resolveUnscoredNoEval(c);
    }
    if (c.localStatus === 'correct' && c.index !== c.currentQuestionIndex) {
      return this.cacheAndReturn(c, c.localStatus);
    }
    if (c.evaluatedStatus === true || c.evaluatedStatus === false) {
      return this.persistAndCache(c, c.evaluatedStatus ? 'correct' : 'wrong');
    }
    const finalConfirmed = this.selectedOptionService.clickConfirmedDotStatus.get(c.index);
    if (finalConfirmed === 'correct' || finalConfirmed === 'wrong') {
      return this.cacheAndReturn(c, finalConfirmed);
    }
    try {
      const sessionVal = sessionStorage.getItem(SK_DOT_CONFIRMED + c.index);
      if (sessionVal === 'correct' || sessionVal === 'wrong') {
        return this.cacheAndReturn(c, sessionVal);
      }
    } catch (err: unknown) { swallow('quiz-dot-status.service.ts', err); }

    return 'pending';
  }

  /** No-scored-state, no-eval restore: previous cache, persisted, confirmed, else pending. Extracted verbatim. */
  private resolveUnscoredNoEval(c: ScoredDotCtx): DotStatus {
    if (c.previousCached === 'correct' || c.previousCached === 'wrong') {
      return this.cacheAndReturn(c, c.previousCached);
    }
    if (c.localStatus === 'correct' || c.localStatus === 'wrong') {
      return this.cacheAndReturn(c, c.localStatus);
    }
    const confirmed2 = this.selectedOptionService.clickConfirmedDotStatus.get(c.index);
    if (confirmed2 === 'correct' || confirmed2 === 'wrong') {
      return this.cacheAndReturn(c, confirmed2);
    }
    return this.cacheAndReturn(c, 'pending');
  }

  // ═══════════════════════════════════════════════════════════════
  // GET DOT CLASS
  // ═══════════════════════════════════════════════════════════════

  getDotClass(params: {
    index: number;
    quizId: string;
    currentQuestionIndex: number;
    optionsToDisplay: Option[];
    currentQuestion: QuizQuestion | null;
    questionsArray: QuizQuestion[];
    dotStatusCache: Map<number, 'correct' | 'wrong' | 'pending'>;
    pendingDotStatusOverrides: Map<number, 'correct' | 'wrong'>;
    activeDotClickStatus: Map<number, 'correct' | 'wrong'>;
    timerExpiredUnanswered: Set<number>;
  }): string {
    const {
      index, quizId, currentQuestionIndex, dotStatusCache,
      pendingDotStatusOverrides, activeDotClickStatus, timerExpiredUnanswered,
    } = params;

    if (index === currentQuestionIndex) {
      const lastClickedCorrect = this.selectedOptionService.lastClickedCorrectByQuestion.get(index);
      if (lastClickedCorrect !== undefined) {
        return `${lastClickedCorrect ? 'correct' : 'wrong'} current`;
      }

      const activeClickStatus = activeDotClickStatus.get(index);
      if (activeClickStatus) return `${activeClickStatus} current`;

      const pendingOverrideStatus = pendingDotStatusOverrides.get(index);
      if (pendingOverrideStatus) return `${pendingOverrideStatus} current`;

      if (!this.quizStateService.hasUserInteracted(index)) {
        // On refresh, interaction state is lost — check clickConfirmedDotStatus (from sessionStorage)
        const confirmedStatus = this.selectedOptionService.clickConfirmedDotStatus.get(index);
        if (confirmedStatus === 'correct' || confirmedStatus === 'wrong') {
          return `${confirmedStatus} current`;
        }
        if (timerExpiredUnanswered.has(index)) return 'pending';
        
        return 'current';
      }

      const cachedStatus = dotStatusCache.get(index);
      if (cachedStatus && cachedStatus !== 'pending') {
        return `${cachedStatus} current`;
      }

      const persistedStatus = this.persistence.getPersistedDotStatus(quizId, index);
      if (persistedStatus === 'correct' || persistedStatus === 'wrong') {
        return `${persistedStatus} current`;
      }

      if (timerExpiredUnanswered.has(index)) return 'pending';

      return 'current';
    }

    // Non-current question
    if (timerExpiredUnanswered.has(index)) return 'pending';

    const scoringKey = this.getScoringKey(quizId, index);
    const scoredCorrect = this.quizService.questionCorrectness.get(scoringKey);
    const persisted = this.persistence.getPersistedDotStatus(quizId, index);
    const confirmed = this.selectedOptionService.clickConfirmedDotStatus.get(index);
    const ssStored = (() => {
      try {
        return sessionStorage.getItem(SK_DOT_CONFIRMED + index);
      } catch {
        return null;
      }
    })();

    // 1. Ground truth: questionCorrectness
    if (scoredCorrect === true) return 'correct';

    // 2. Persisted dot status (localStorage)
    if (persisted === 'correct') return 'correct';

    // 3. clickConfirmedDotStatus (in-memory or sessionStorage fallback)
    if (confirmed) return confirmed;
    if (ssStored === 'correct' || ssStored === 'wrong') {
      this.selectedOptionService.clickConfirmedDotStatus.set(index, ssStored);
      return ssStored;
    }

    // 4. Explicit wrong from scoring
    if (scoredCorrect === false) return 'wrong';
    if (persisted === 'wrong') return 'wrong';

    // 5. Fallback
    const status = this.getQuestionStatus({ ...params, options: undefined });
    return status;
  }

  // ═══════════════════════════════════════════════════════════════
  // PROGRESS COMPUTATION
  // ═══════════════════════════════════════════════════════════════

  computeTotalCount(
    totalQuestions: number,
    serviceQuestionsLength: number,
    quizQuestionsLength: number
  ): number {
    if (totalQuestions > 0) return totalQuestions;
    if (serviceQuestionsLength > 0) return serviceQuestionsLength;
    return quizQuestionsLength;
  }

  // ═══════════════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════════

  private getFallbackOptions(
    index: number,
    currentQuestionIndex: number,
    optionsToDisplay: Option[],
    currentQuestion: QuizQuestion | null
  ): Option[] {
    return index === currentQuestionIndex
      ? ((Array.isArray(optionsToDisplay) && optionsToDisplay.length > 0)
          ? optionsToDisplay
          : (Array.isArray(currentQuestion?.options) ? currentQuestion!.options as Option[] : []))
      : [];
  }
}
