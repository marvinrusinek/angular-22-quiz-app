import { Service, inject } from '@angular/core';

import { Option } from '../../models/Option.model';
import { QuizQuestion } from '../../models/QuizQuestion.model';
import { SelectedOption } from '../../models/SelectedOption.model';

import { NextButtonStateService } from '../state/next-button-state.service';
import { QuizDotStatusService } from './quiz-dot-status.service';
import { QuizPersistenceService } from '../state/quiz-persistence.service';
import { QuizScoringService } from './quiz-scoring.service';
import { QuizService } from '../data/quiz.service';
import { QuizStateService } from '../state/quizstate.service';
import { SelectedOptionService } from '../state/selectedoption.service';
import { TimerService } from '../features/timer/timer.service';
import { SK_DISPLAY_MODE, SK_DOT_CONFIRMED, SK_IS_ANSWERED } from '../../constants/session-keys';
import { writeSessionString } from '../../utils/session-storage';

import { isOptionCorrect } from '../../utils/is-option-correct';
import { norm } from '../../utils/text-norm';
import { swallow } from '../../utils/error-logging';

/**
 * Result of evaluating immediate correctness for an option click.
 */
export interface ImmediateCorrectnessResult {
  liveCorrectness: boolean | null;
  usedExplicitPayloadCorrectness: boolean;
  canPersistOptimisticStatus: boolean;
  isSingleAnswerQuestion: boolean;
  correctCountForQuestion: number;
  immediateSelections: SelectedOption[];
  questionForSelection: QuizQuestion | null;
  optionsForImmediateScoring: Option[];
  correctOptionsForQuestion: Option[];
}

/**
 * Result of single-answer scoring evaluation.
 */
export interface SingleAnswerResult {
  clickedIsCorrect: boolean;
  dotStatus: 'correct' | 'wrong';
}

/**
 * Result of multi-answer evaluation.
 */
export interface MultiAnswerResult {
  allCorrectSelected: boolean;
  hasIncorrectSelection: boolean;
  hasAnyCorrectSelection: boolean;
  immediateMultiDotStatus: 'correct' | 'wrong' | null;
  currentSelections: SelectedOption[];
  syncIds: any[];
}

/**
 * Combined result of full option evaluation.
 */
export interface OptionEvaluationResult {
  immediate: ImmediateCorrectnessResult;
  singleAnswer: SingleAnswerResult | null;
  multiAnswer: MultiAnswerResult | null;
}

/**
 * Handles the heavy evaluation and scoring logic from onOptionSelected.
 * Extracted from QuizComponent to reduce its size.
 */
@Service()
export class QuizOptionProcessingService {
  // -- injects -----------------------------------------------------
  private dotStatusService = inject(QuizDotStatusService);
  private nextButtonStateService = inject(NextButtonStateService);
  private quizPersistence = inject(QuizPersistenceService);
  private quizScoringService = inject(QuizScoringService);
  private quizService = inject(QuizService);
  private quizStateService = inject(QuizStateService);
  private selectedOptionService = inject(SelectedOptionService);
  private timerService = inject(TimerService);

  // -- public methods ----------------------------------------------

  // ===============================================================
  // FULL OPTION CLICK ORCHESTRATION
  // ===============================================================

  /**
   * Runs the full evaluation chain after a user option click.
   * Returns the params used so the caller can finalize per-question state.
   * Caller is responsible for updateProgressValue / updateDotStatus / CD.
   */
  async processOptionClick(params: {
    option: SelectedOption;
    idx: number;
    quizId: string;
    currentQuestionIndex: number;
    questionsArray: QuizQuestion[];
    currentQuestion: QuizQuestion | null;
    optionsToDisplay: Option[];
    liveSelections: SelectedOption[];
    explanationToDisplay: string;
  }): Promise<void> {
    const { option, idx, quizId } = params;

    this.quizStateService.markUserInteracted(idx);

    const immediate = this.evaluateImmediateCorrectness({
      option, idx, liveSelections: params.liveSelections,
      questionsArray: params.questionsArray, currentQuestion: params.currentQuestion,
      optionsToDisplay: params.optionsToDisplay, quizId,
      currentQuestionIndex: params.currentQuestionIndex
    });

    if (immediate.canPersistOptimisticStatus) {
      this.quizPersistence.setPersistedDotStatus(quizId, idx, 'correct');
      this.dotStatusService.pendingDotStatusOverrides.set(idx, 'correct');
    }

    let immediateMultiDotStatus: 'correct' | 'wrong' | null = null;
    let isQuestionComplete = immediate.isSingleAnswerQuestion;
    if (immediate.isSingleAnswerQuestion) {
      this.evaluateSingleAnswer({
        option, idx, optionsForImmediateScoring: immediate.optionsForImmediateScoring,
        liveCorrectness: immediate.liveCorrectness, quizId
      });
    } else {
      const multiResult = this.evaluateMultiAnswer({
        option, idx, immediateSelections: immediate.immediateSelections,
        questionForSelection: immediate.questionForSelection,
        optionsForImmediateScoring: immediate.optionsForImmediateScoring,
        correctOptionsForQuestion: immediate.correctOptionsForQuestion,
        quizId
      });
      immediateMultiDotStatus = multiResult.immediateMultiDotStatus;
      isQuestionComplete = multiResult.allCorrectSelected;
    }

    await this.handleAuthoritativeCheck({
      idx, isSingleAnswerQuestion: immediate.isSingleAnswerQuestion,
      immediateMultiDotStatus, quizId
    });

    this.nextButtonStateService.setNextButtonState(isQuestionComplete);
    if (isQuestionComplete) {
      this.quizStateService.markQuestionAnswered(idx);
      const prev = this.quizStateService.getQuestionState(quizId, idx);
      if (prev) {
        this.quizStateService.setQuestionState(quizId, idx, {
          ...prev, isAnswered: true,
          explanationText: params.explanationToDisplay || prev.explanationText || ''
        });
      }
    }

    this.persistOptionSelection({
      idx, quizId, explanationToDisplay: params.explanationToDisplay, option,
      isQuestionComplete
    });
  }


  // ===============================================================
  // EVALUATE IMMEDIATE CORRECTNESS
  // ===============================================================

  evaluateImmediateCorrectness(params: {
    option: SelectedOption;
    idx: number;
    liveSelections: SelectedOption[];
    questionsArray: QuizQuestion[];
    currentQuestion: QuizQuestion | null;
    optionsToDisplay: Option[];
    quizId: string;
    currentQuestionIndex: number;
  }): ImmediateCorrectnessResult {
    const { option, idx, liveSelections, questionsArray, currentQuestion, optionsToDisplay, currentQuestionIndex } = params;

    const questionForSelection =
      this.quizService.questions?.[idx] ||
      questionsArray?.[idx] ||
      this.quizService.activeQuiz?.questions?.[idx] ||
      null;

    const optionsForImmediateScoring: Option[] =
      (questionForSelection?.options as Option[]) ||
      (currentQuestion?.options as Option[]) ||
      (optionsToDisplay as Option[]) ||
      [];

    const correctOptionsForQuestion = this.dotStatusService.getResolvedCorrectOptions(
      questionForSelection as QuizQuestion | null | undefined,
      optionsForImmediateScoring
    );

    let correctCountForQuestion = correctOptionsForQuestion.length;

    // PRISTINE MULTI-ANSWER GUARD: the resolved correct count can be wrong
    // when option.correct flags are mutated or incomplete in the runtime
    // question objects. Cross-check against the pristine quiz bundle to
    // detect true multi-answer questions that were misclassified.
    try {
      const qText = norm(questionForSelection?.questionText ?? currentQuestion?.questionText);
      if (qText) {
        const bundle = this.quizService?.quizInitialState ?? [];
        for (const quiz of bundle) {
          for (const pq of (quiz?.questions ?? [])) {
            if (norm(pq?.questionText) !== qText) continue;
            const pristineCorrectCount = (pq?.options ?? [])
              .filter((o: any) => isOptionCorrect(o)).length;
            if (pristineCorrectCount > correctCountForQuestion) {
              correctCountForQuestion = pristineCorrectCount;
            }
            break;
          }
          if (correctCountForQuestion > 1) break;
        }
      }
    } catch (err: unknown) { swallow('quiz-option-processing.service.ts', err); /* ignore */ }

    const isSingleAnswerQuestion = correctCountForQuestion === 1;

    const immediateSelections = this.quizScoringService.buildImmediateSelectionsForScoring(
      idx,
      liveSelections,
      option,
      isSingleAnswerQuestion
    );

    let liveCorrectness = this.dotStatusService.evaluateSelectionCorrectness({
      index: idx,
      selections: immediateSelections,
      currentQuestionIndex,
      optionsToDisplay,
      currentQuestion,
      questionsArray
    });

    let usedExplicitPayloadCorrectness = false;
    const hasExplicitCorrectFlag = option?.correct !== undefined && option?.correct !== null;

    if (hasExplicitCorrectFlag) {
      const payloadCorrect = isOptionCorrect(option);
      if (isSingleAnswerQuestion) {
        liveCorrectness = payloadCorrect;
        usedExplicitPayloadCorrectness = true;
      } else if (payloadCorrect) {
        liveCorrectness = true;
        usedExplicitPayloadCorrectness = true;
      } else if (liveCorrectness !== true && liveCorrectness !== false) {
        liveCorrectness = false;
        usedExplicitPayloadCorrectness = true;
      }
    }

    const canPersistOptimisticStatus =
      isSingleAnswerQuestion && liveCorrectness === true;

    return {
      liveCorrectness,
      usedExplicitPayloadCorrectness,
      canPersistOptimisticStatus,
      isSingleAnswerQuestion,
      correctCountForQuestion,
      immediateSelections,
      questionForSelection,
      optionsForImmediateScoring,
      correctOptionsForQuestion
    };
  }

  // ===============================================================
  // EVALUATE SINGLE-ANSWER SCORING
  // ===============================================================

  evaluateSingleAnswer(params: {
    option: SelectedOption;
    idx: number;
    optionsForImmediateScoring: Option[];
    liveCorrectness: boolean | null;
    quizId: string;
  }): SingleAnswerResult {
    const { option, idx, optionsForImmediateScoring, liveCorrectness, quizId } = params;

    const normalize = (value: unknown): string => norm(value);
    const clickedOptionId = String(option?.optionId ?? '').trim();
    const clickedText = normalize(option?.text);
    const payloadSaysCorrect = isOptionCorrect(option);

    const sourceOptions: Option[] = optionsForImmediateScoring;

    const matchedCorrectOption = sourceOptions.some((opt: Option) => {
      const optId = String(opt?.optionId ?? '').trim();
      const optText = normalize(opt?.text);
      const isCorrect = isOptionCorrect(opt);

      const idMatch = clickedOptionId !== '' && optId !== '' && clickedOptionId === optId;
      const textMatch = clickedText !== '' && optText !== '' && clickedText === optText;
      return isCorrect && (idMatch || textMatch);
    });

    const payloadIndex = Number((option as any)?.displayIndex ?? (option as any)?.index ?? -1);
    const indexMatchedCorrect =
      Number.isInteger(payloadIndex) && payloadIndex >= 0 && payloadIndex < sourceOptions.length
        ? isOptionCorrect(sourceOptions[payloadIndex])
        : false;

    const clickedIsCorrect = payloadSaysCorrect || matchedCorrectOption || indexMatchedCorrect || liveCorrectness === true;

    if (clickedIsCorrect) {
      this.quizPersistence.setPersistedDotStatus(quizId, idx, 'correct');
      this.dotStatusService.pendingDotStatusOverrides.set(idx, 'correct');
      this.dotStatusService.dotStatusCache.set(idx, 'correct');
      this.selectedOptionService.clickConfirmedDotStatus.set(idx, 'correct');
      writeSessionString(SK_DOT_CONFIRMED + idx, 'correct');
      // Capture the live elapsed now so the frozen revisit shows the right
      // seconds-remaining — covers the last question (no capture-on-leave).
      this.timerService.recordElapsedForAnsweredQuestion(idx);
      // NO SCORE HERE. `clickedIsCorrect` is decided locally from the answer
      // key; credit comes from creditResolvedQuestion on verdict arrival. The
      // dot status and elapsed capture above are interaction facts, not
      // correctness claims, so they stay.
    } else {
      this.selectedOptionService.clickConfirmedDotStatus.set(idx, 'wrong');
      writeSessionString(SK_DOT_CONFIRMED + idx, 'wrong');
    }

    return {
      clickedIsCorrect,
      dotStatus: clickedIsCorrect ? 'correct' : 'wrong'
    };
  }

  // ===============================================================
  // EVALUATE MULTI-ANSWER SCORING
  // ===============================================================

  evaluateMultiAnswer(params: {
    option: SelectedOption;
    idx: number;
    immediateSelections: SelectedOption[];
    questionForSelection: QuizQuestion | null;
    optionsForImmediateScoring: Option[];
    correctOptionsForQuestion: Option[];
    quizId: string;
  }): MultiAnswerResult {
    const {
      option, idx, immediateSelections, questionForSelection,
      optionsForImmediateScoring, correctOptionsForQuestion, quizId,
    } = params;

    const { allCorrectSelected, hasIncorrectSelection, hasAnyCorrectSelection, currentSelections, syncIds } =
      this.evaluateMultiCorrectness(option, idx, immediateSelections, questionForSelection, optionsForImmediateScoring, correctOptionsForQuestion);

    // NO SCORE HERE — `allCorrectSelected` comes from evaluateMultiCorrectness,
    // which reads the local answer key. Credit is applied by
    // creditResolvedQuestion on authorized verdict arrival.

    const immediateMultiDotStatus = this.computeImmediateDotStatus(
      option, currentSelections, questionForSelection, optionsForImmediateScoring,
      allCorrectSelected, hasIncorrectSelection, hasAnyCorrectSelection
    );

    // NO NEGATIVE SCORE HERE either. This wrote `isCorrect: false` into the
    // ledger from the same answer-key-derived gate. The authorized path never
    // credits an unresolved question, so there is nothing to retract: a
    // question only enters the ledger as correct once the server says so.

    if (immediateMultiDotStatus) this.persistMultiDotStatus(idx, quizId, immediateMultiDotStatus);

    return {
      allCorrectSelected,
      hasIncorrectSelection,
      hasAnyCorrectSelection,
      immediateMultiDotStatus,
      currentSelections,
      syncIds
    };
  }

  /**
   * Multi-answer correctness: add the clicked option, check every correct is
   * selected (canonical AND pristine), and derive incorrect/any-correct flags.
   * No-op (all false) for single-answer questions. Extracted verbatim.
   */
  private evaluateMultiCorrectness(
    option: SelectedOption,
    idx: number,
    immediateSelections: SelectedOption[],
    questionForSelection: QuizQuestion | null,
    optionsForImmediateScoring: Option[],
    correctOptionsForQuestion: Option[]
  ): { allCorrectSelected: boolean; hasIncorrectSelection: boolean; hasAnyCorrectSelection: boolean; currentSelections: SelectedOption[]; syncIds: any[] } {
    const currentSelections: SelectedOption[] = [...immediateSelections];
    if (correctOptionsForQuestion.length <= 1) {
      return { allCorrectSelected: false, hasIncorrectSelection: false, hasAnyCorrectSelection: false, currentSelections, syncIds: [] };
    }

    this.addClickedOptionToSelections(option, currentSelections);

    const correctOptionEntries = this.dotStatusService.getResolvedCorrectOptionEntries(questionForSelection, optionsForImmediateScoring);
    const everyCorrectSelected = correctOptionEntries.every(({ option: correctOpt, index: correctOptIndex }) =>
      currentSelections.some((selection) =>
        this.dotStatusService.selectionMatchesOption(selection, correctOpt, correctOptIndex)
      )
    );

    const rawAllCorrectSelected = this.resolvePristineAllCorrect(questionForSelection, idx, currentSelections, everyCorrectSelected);
    const allCorrectSelected = everyCorrectSelected && rawAllCorrectSelected;

    const hasIncorrectSelection = currentSelections.some((selection) =>
      !this.dotStatusService.matchesAnyCorrectOption(selection, questionForSelection, optionsForImmediateScoring)
    );
    const hasAnyCorrectSelection = currentSelections.some((selection) =>
      this.dotStatusService.matchesAnyCorrectOption(selection, questionForSelection, optionsForImmediateScoring)
    ) && !hasIncorrectSelection;

    const syncIds = currentSelections
      .map((s: any) => s?.optionId)
      .filter((id: any) => id !== undefined && id !== null);
    this.quizService.updateUserAnswer(idx, syncIds);

    return { allCorrectSelected, hasIncorrectSelection, hasAnyCorrectSelection, currentSelections, syncIds };
  }

  /**
   * Pristine cross-check: mutated question data can have reduced correct flags,
   * so re-validate "all correct selected" against pristine correct texts
   * (by question text, then by index). Extracted verbatim.
   */
  private resolvePristineAllCorrect(questionForSelection: QuizQuestion | null, idx: number, currentSelections: SelectedOption[], everyCorrectSelected: boolean): boolean {
    let rawAllCorrectSelected = everyCorrectSelected;
    try {
      const bundle = this.quizService?.quizInitialState ?? [];
      const quizIdVal = this.quizService?.quizId;
      const qText = norm(questionForSelection?.questionText);
      let pristineCorrectTexts: string[] = [];

      if (qText && bundle.length > 0) {
        for (const quiz of bundle) {
          for (const pq of (quiz?.questions ?? [])) {
            if (norm(pq?.questionText) !== qText) continue;
            pristineCorrectTexts = this.pristineCorrectTextsOf(pq);
            break;
          }
          if (pristineCorrectTexts.length > 0) break;
        }
      }

      if (pristineCorrectTexts.length === 0 && quizIdVal) {
        const pristineQuiz = bundle.find((qz: any) => qz?.quizId === quizIdVal);
        const pristineQ = pristineQuiz?.questions?.[idx];
        if (pristineQ) pristineCorrectTexts = this.pristineCorrectTextsOf(pristineQ);
      }

      if (pristineCorrectTexts.length > 0) {
        const selTexts = new Set(currentSelections.map((s: any) => norm(s?.text)).filter((t: string) => !!t));
        rawAllCorrectSelected = pristineCorrectTexts.every((t: string) => selTexts.has(t));
      }
    } catch (err: unknown) { swallow('quiz-option-processing.service.ts', err); /* trust canonical */ }
    return rawAllCorrectSelected;
  }

  /** Append the clicked option to currentSelections when it's selected and not already present. Extracted verbatim. */
  private addClickedOptionToSelections(option: SelectedOption, currentSelections: SelectedOption[]): void {
    const clickedIndex = Number((option as any)?.displayIndex ?? (option as any)?.index ?? -1);
    const optionIsCurrentlySelected =
      option?.selected === true ||
      (option as any)?.checked === true ||
      (option as any)?.isSelected === true;
    const alreadyIncluded = currentSelections.some((selection) =>
      this.dotStatusService.selectionMatchesOption(selection, option, clickedIndex)
    );
    if (optionIsCurrentlySelected && !alreadyIncluded && option) {
      currentSelections.push(option as SelectedOption);
    }
  }

  /** Normalized correct-option texts of a pristine question. */
  private pristineCorrectTextsOf(pq: any): string[] {
    return (pq?.options ?? [])
      .filter((o: any) => isOptionCorrect(o))
      .map((o: any) => norm(o?.text))
      .filter((t: string) => !!t);
  }

  /** Immediate multi-answer dot status from the click + aggregate selection flags. Extracted verbatim. */
  private computeImmediateDotStatus(
    option: SelectedOption,
    currentSelections: SelectedOption[],
    questionForSelection: QuizQuestion | null,
    optionsForImmediateScoring: Option[],
    allCorrectSelected: boolean,
    hasIncorrectSelection: boolean,
    hasAnyCorrectSelection: boolean
  ): 'correct' | 'wrong' | null {
    const clickedIndex = Number((option as any)?.displayIndex ?? (option as any)?.index ?? -1);
    const clickedOptionIsCorrect =
      isOptionCorrect(option) ||
      this.dotStatusService.matchesAnyCorrectOption(option as SelectedOption, questionForSelection, optionsForImmediateScoring) || (
        Number.isInteger(clickedIndex) &&
        clickedIndex >= 0 &&
        clickedIndex < optionsForImmediateScoring.length &&
        isOptionCorrect(optionsForImmediateScoring[clickedIndex])
      );

    const explicitSelectedState = option?.selected ?? (option as any)?.checked ?? (option as any)?.isSelected;
    const clickedOptionIsStillSelected = currentSelections.some((selection) =>
      this.dotStatusService.selectionMatchesOption(selection, option as SelectedOption, clickedIndex)
    );
    const clickedOptionWasDeselected = explicitSelectedState === false ? true : !clickedOptionIsStillSelected;

    if (allCorrectSelected && !hasIncorrectSelection) return 'correct';
    if (clickedOptionWasDeselected) {
      if (clickedOptionIsCorrect || hasIncorrectSelection) return 'wrong';
      if (hasAnyCorrectSelection) return 'correct';
      return null;
    }
    if (clickedOptionIsCorrect) return 'correct';
    if (hasIncorrectSelection || hasAnyCorrectSelection) return 'wrong';
    return null;
  }

  /** Persist the immediate multi dot status across the dot-status caches/services. Extracted verbatim. */
  private persistMultiDotStatus(idx: number, quizId: string, status: 'correct' | 'wrong'): void {
    this.dotStatusService.activeDotClickStatus.set(idx, status);
    this.quizPersistence.setPersistedDotStatus(quizId, idx, status);
    this.dotStatusService.pendingDotStatusOverrides.set(idx, status);
    this.dotStatusService.dotStatusCache.set(idx, status);
    this.selectedOptionService.clickConfirmedDotStatus.set(idx, status);
  }

  // ===============================================================
  // HANDLE AUTHORITATIVE CORRECTNESS CHECK
  // ===============================================================

  async handleAuthoritativeCheck(params: {
    idx: number;
    isSingleAnswerQuestion: boolean;
    immediateMultiDotStatus: 'correct' | 'wrong' | null;
    quizId: string;
  }): Promise<void> {
    const { idx, isSingleAnswerQuestion, immediateMultiDotStatus, quizId } = params;

    const authoritativeCorrectness = await this.quizService.checkIfAnsweredCorrectly(idx, false);

    if (authoritativeCorrectness === true) {
      // PRISTINE GUARD: checkIfAnsweredCorrectly uses potentially-mutated
      // question data, so it can return true prematurely for multi-answer
      // questions (e.g. reports 1 correct when pristine has 2). Cross-check
      // against quizInitialState to ensure ALL correct answers are selected.
      let pristineBlocked = false;
      if (!isSingleAnswerQuestion) {
        try {
          const bundle = this.quizService?.quizInitialState ?? [];
          const q = this.quizService.questions?.[idx];
          const qText = norm(q?.questionText);
          let pristineCorrectTexts: string[] = [];

          if (qText) {
            for (const quiz of bundle) {
              for (const pq of (quiz?.questions ?? [])) {
                if (norm(pq?.questionText) !== qText) continue;
                pristineCorrectTexts = (pq?.options ?? [])
                  .filter((o: any) => isOptionCorrect(o))
                  .map((o: any) => norm(o?.text))
                  .filter((t: string) => !!t);
                break;
              }
              if (pristineCorrectTexts.length > 0) break;
            }
          }

          if (pristineCorrectTexts.length === 0 && this.quizService.quizId) {
            const pristineQuiz = bundle.find((qz: any) => qz?.quizId === this.quizService.quizId);
            const pristineQ = pristineQuiz?.questions?.[idx];
            if (pristineQ) {
              pristineCorrectTexts = (pristineQ?.options ?? [])
                .filter((o: any) => isOptionCorrect(o))
                .map((o: any) => norm(o?.text))
                .filter((t: string) => !!t);
            }
          }

          if (pristineCorrectTexts.length > 1) {
            const selections = this.selectedOptionService.getSelectedOptionsForQuestion(idx) ?? [];
            const selTexts = new Set(selections.map((s: any) => norm(s?.text)).filter((t: string) => !!t));
            const allPristineSelected = pristineCorrectTexts.every(t => selTexts.has(t));
            if (!allPristineSelected) pristineBlocked = true;
          }
        } catch (err: unknown) {
          console.error('QuizOptionProcessingService.handleAuthoritativeCheck pristine guard failed:', err);
        }
      }

      if (!pristineBlocked) {
        // NO SCORE HERE. The `pristineBlocked` gate is an explicit answer-key
        // cross-check; credit comes from creditResolvedQuestion. The persisted
        // dot status stays — it records what the user did, not whether the
        // server agreed.
        this.quizPersistence.setPersistedDotStatus(quizId, idx, 'correct');
      }
    } else if (!isSingleAnswerQuestion && immediateMultiDotStatus) {
      this.quizPersistence.setPersistedDotStatus(quizId, idx, immediateMultiDotStatus);
    }
  }

  // ===============================================================
  // PERSIST OPTION SELECTION TO SESSION
  // ===============================================================

  persistOptionSelection(params: {
    idx: number;
    quizId: string;
    explanationToDisplay: string;
    option: SelectedOption;
    isQuestionComplete?: boolean;
  }): void {
    const { idx, isQuestionComplete = true } = params;

    // Note: QuizStateService update is handled by the component since it needs the service reference

    // Persist to session
    try {
      const currentIndices = this.selectedOptionService.getSelectedOptionIndices(idx);
      sessionStorage.setItem(`quiz_selection_${idx}`, JSON.stringify(currentIndices));
      if (isQuestionComplete) {
        sessionStorage.setItem(SK_IS_ANSWERED, 'true');
        sessionStorage.setItem(SK_DISPLAY_MODE + idx, 'explanation');
      }
    } catch (err: unknown) {
      console.error('QuizOptionProcessingService.persistOptionSelection session-persist failed:', err);
    }

    // Ensure sessionStorage has a dot_confirmed_ entry
    try {
      if (sessionStorage.getItem(SK_DOT_CONFIRMED + idx) === null) {
        const finalDotStatus = this.dotStatusService.pendingDotStatusOverrides.get(idx)
          ?? this.dotStatusService.activeDotClickStatus.get(idx)
          ?? this.dotStatusService.dotStatusCache.get(idx);
        if (finalDotStatus === 'correct' || finalDotStatus === 'wrong') {
          sessionStorage.setItem(SK_DOT_CONFIRMED + idx, finalDotStatus);
        } else {
          const clickedCorrect = isOptionCorrect(params.option);
          sessionStorage.setItem(SK_DOT_CONFIRMED + idx, clickedCorrect ? 'correct' : 'wrong');
        }
      }
    } catch (err: unknown) { swallow('quiz-option-processing.service.ts', err); }
  }
}