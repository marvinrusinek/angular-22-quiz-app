import { Service, inject } from '@angular/core';
import { Subscription } from 'rxjs';
import { filter, take } from 'rxjs/operators';

import { QuestionType } from '../../../models/question-type.enum';

import { FeedbackProps } from '../../../models/FeedbackProps.model';
import { Option } from '../../../models/Option.model';
import { OptionBindings } from '../../../models/OptionBindings.model';

import { SK_MULTI_PERFECT, SK_SEL_Q } from '../../../constants/session-keys';
import { isOptionCorrect } from '../../../utils/is-option-correct';
import { writeSessionString } from '../../../utils/session-storage';

import { ExplanationTextService } from '../../features/explanation/explanation-text.service';
import { FeedbackService } from '../../features/feedback/feedback.service';
import { NextButtonStateService } from '../../state/next-button-state.service';
import { OptionClickHandlerService } from './option-click-handler.service';
import { QuestionVerdictService } from '../../features/verdict/question-verdict.service';
import type { QuestionVerdictState } from '../../features/verdict/question-verdict.types';
import {
  allCorrectSelectedFromVerdict,
  selectedVerdictFor
} from '../../features/verdict/authorized-correctness';
import { QuizService } from '../../data/quiz.service';
import { QuizStateService } from '../../state/quizstate.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { SelectionMessageService } from '../../features/selection-message/selection-message.service';
import { SharedOptionExplanationService } from '../../features/shared-option/shared-option-explanation.service';
import { TimerService } from '../../features/timer/timer.service';
import { norm } from '../../../utils/text-norm';

/** Delay before backup explanation emission after all correct answers are selected in multi-answer mode. */
const MULTI_ANSWER_BACKUP_FET_DELAY_MS = 50;

/**
 * Handles multi-answer and single-answer click processing logic.
 * Extracted from SharedOptionClickService.runOptionContentClick.
 */
@Service()
export class SocAnswerProcessingService {
  // ── injects ─────────────────────────────────────────────────────
  private clickHandler = inject(OptionClickHandlerService);
  private explanationTextService = inject(ExplanationTextService);
  private feedbackService = inject(FeedbackService);
  private nextButtonStateService = inject(NextButtonStateService);
  private quizService = inject(QuizService);
  private quizStateService = inject(QuizStateService);
  private selectedOptionService = inject(SelectedOptionService);
  private selectionMessageService = inject(SelectionMessageService);
  private sharedOptionExplanationService = inject(SharedOptionExplanationService);
  private timerService = inject(TimerService);
  private verdicts = inject(QuestionVerdictService);

  /**
   * Questions with a terminal-repaint wait outstanding, keyed by quiz+question.
   *
   * Every click on an unfinished multi-answer question registers the intent to
   * repaint, but only one wait may exist per question — otherwise the completing
   * verdict is answered once per click. Entries are removed when the wait fires
   * (the stream is `take(1)`), so this never accumulates.
   */
  private readonly pendingRespreads = new Map<string, Subscription>();

  // ── public methods ──────────────────────────────────────────────

  /**
   * Processes a multi-answer option click: updates disabled set, bindings,
   * feedback, selection message, and triggers FET when all correct are selected.
   */
  /**
   * Shared FET write for a resolved (correctly-answered) question: set the
   * active-index/latest fields, cache the formatted explanation, push it through
   * the explanation pipeline (display + lock), set the display state, and stamp
   * the H3 heading. Used by BOTH processMultiAnswerClick (all-correct) and
   * processSingleAnswerClick (correct) — the sequence was identical in both,
   * only the source variable names differed. displayIdx keys all the
   * display-pipeline calls. FET-pipeline code — keep byte-for-byte.
   */
  /**
   * Shared score + FET-gate prologue for a correctly-answered question: stop the
   * timer, open the FET bypass (display-index keyed — CQC/navigation read by
   * display index), score (qIdx is canonical; scoreDirectly maps shuffle
   * internally; isMulti distinguishes the two callers), enable Next, and run the
   * post-score tail. Used by both process*AnswerClick correct paths.
   */
  /**
   * Multi-answer all-correct FET: score+open gates, resolve the explanation
   * (pristine question by text, else live question), format it as the
   * multi-answer "Options X and Y..." form via writeResolvedFet, and schedule a
   * component-path backup emit. Extracted verbatim from processMultiAnswerClick.
   */
  private emitMultiAnswerFetOnAllCorrect(comp: any, qIdx: number, displayIdx: number, effectiveCorrectIndices: number[], isShuffled: boolean): void {
    this.scoreAndOpenFet(comp, qIdx, displayIdx, true);

    // Resolve explanation text from pristine data and write directly
    let fetText = '';
    try {
      const fetQText = isShuffled
        ? (this.quizService?.getQuestionsInDisplayOrder?.()?.[displayIdx]?.questionText
          ?? this.quizService?.shuffledQuestions?.[displayIdx]?.questionText)
        : (comp.currentQuestion()?.questionText
          ?? this.quizService?.questions?.[qIdx]?.questionText);
      const pristineFETQ = this.quizService.getPristineQuestionByText(fetQText);
      fetText = ((pristineFETQ as any)?.explanation ?? '').trim();
      // Also try live question objects
      if (!fetText) {
        const liveQ = comp.currentQuestion()
          ?? comp.getQuestionAtDisplayIndex?.(displayIdx)
          ?? this.quizService?.getQuestionsInDisplayOrder?.()?.[displayIdx];
        fetText = (liveQ?.explanation ?? '').trim();
      }
    } catch (err: unknown) { console.error('processMultiAnswerClick FET-text resolution failed:', err); }

    if (fetText) {
      // Format as "Options X and Y are correct because ..." using 1-based
      // option numbers (matches the multi-answer FET formatter elsewhere).
      let formattedFET = fetText;
      try {
        const oneBasedIndices = effectiveCorrectIndices
          .map((ci: number) => ci + 1)
          .filter((n: number) => Number.isFinite(n) && n > 0);
        const qForFormat = comp.currentQuestion()
          ?? comp.getQuestionAtDisplayIndex?.(displayIdx)
          ?? this.quizService?.getQuestionsInDisplayOrder?.()?.[displayIdx]
          ?? this.quizService?.questions?.[qIdx];
        if (qForFormat && oneBasedIndices.length > 0) {
          formattedFET = this.explanationTextService.formatExplanation(qForFormat, oneBasedIndices, fetText);
        }
      } catch (err: unknown) { console.error('processMultiAnswerClick FET formatting failed:', err); }

      const qForStore = comp.currentQuestion()
        ?? comp.getQuestionAtDisplayIndex?.(displayIdx)
        ?? this.quizService?.getQuestionsInDisplayOrder?.()?.[displayIdx];
      this.writeResolvedFet(displayIdx, formattedFET, qForStore);
    }

    // Also try the component path as backup
    setTimeout(() => {
      try {
        comp.emitExplanation(displayIdx, true);
      } catch { /* ignore */ }
    }, MULTI_ANSWER_BACKUP_FET_DELAY_MS);
  }

  /**
   * Was the clicked single-answer option correct?
   *
   * The verdict for the user's OWN selection answers this directly — it is the
   * one fact a check discloses about a pick. The bank scan below is the
   * compatibility path for when nothing has been checked yet.
   *
   * Formerly `isPristineSingleCorrect`, which named the fallback as if it were
   * the authority.
   */
  private isSingleAnswerClickCorrect(comp: any, index: number, qIdx: number, displayIdx: number, isShuffled: boolean): boolean {
    const clickedText = norm(comp.optionBindings()?.[index]?.option?.text);

    // AUTHORIZED. `undefined` means this pick carries no verdict yet, which is
    // not the same as a wrong pick — hence the explicit check.
    const own = selectedVerdictFor(
      this.resolveVerdictStateForComp(comp),
      comp.optionBindings()?.[index]?.option?.text
    );
    if (own !== undefined) return own;

    // REMOVE WITH THE IDLE/CHECKING/ERROR CLEANUP — the pre-verdict path. The
    // several question-text candidates below exist because currentQuestion can
    // be stale right after navigation, and because shuffle reorders display.
    try {
      const clickedBinding = comp.optionBindings()?.[index];
      if (isOptionCorrect(clickedBinding?.option)) {
        return true;
      } else if (clickedText) {
        const candidates = isShuffled
          ? [
              comp.currentQuestion()?.questionText,
              this.quizService?.getQuestionsInDisplayOrder?.()?.[displayIdx]?.questionText,
              this.quizService?.shuffledQuestions?.[displayIdx]?.questionText,
              this.quizService?.questions?.[qIdx]?.questionText,
            ]
          : [
              this.quizService?.questions?.[qIdx]?.questionText,
              this.quizService?.getQuestionsInDisplayOrder?.()?.[qIdx]?.questionText,
              comp.currentQuestion()?.questionText
            ];
        for (const qText of candidates) {
          if (!qText) continue;
          const pristineCorrectTextsSA =
            this.quizService.getPristineCorrectTextsForQuestion(qText);
          if (pristineCorrectTextsSA.has(clickedText)) {
            return true;
          }
        }
      }
    } catch (err: unknown) { console.error('processSingleAnswerClick pristine-correct check failed:', err); }
    return false;
  }

  /**
   * Single-answer FET emit: synchronous write of the resolved explanation
   * (via writeResolvedFet) plus a backup emit through the shared-option
   * explanation service (falling back to the component path). Extracted verbatim.
   */
  private emitSingleAnswerFet(comp: any, displayIdx: number, singleFetQuestion: any): void {
    // Synchronous FET write
    try {
      const singleFetCtxSync = {
        resolvedIndex: displayIdx,
        question: singleFetQuestion,
        currentQuestion: comp.currentQuestion(),
        quizId: comp.quizId?.() ?? comp.quizId ?? '',
        optionBindings: comp.optionBindings() ?? [],
        optionsToDisplay: comp.optionsToDisplay ?? [],
        isMultiMode: false
      };
      const fetText = this.sharedOptionExplanationService.resolveExplanationText(singleFetCtxSync as any)?.trim()
        || singleFetQuestion?.explanation || '';
      if (fetText) {
        // Shared FET write (same sequence as the multi-answer path).
        this.writeResolvedFet(displayIdx, fetText, singleFetQuestion);
      }
    } catch (err: unknown) { console.error('processSingleAnswerClick FET-sync write failed:', err); }

    const singleFetCtx = {
      resolvedIndex: displayIdx,
      question: singleFetQuestion,
      currentQuestion: comp.currentQuestion(),
      quizId: comp.quizId?.() ?? comp.quizId ?? '',
      optionBindings: comp.optionBindings() ?? [],
      optionsToDisplay: comp.optionsToDisplay ?? [],
      isMultiMode: false
    };
    setTimeout(() => {
      try {
        this.sharedOptionExplanationService.emitExplanation(singleFetCtx as any, true);
      } catch (err: unknown) {
        console.error('SocAnswerProcessingService.processSingleAnswerClick FET-backup emission failed:', err);
        comp.emitExplanation(displayIdx, true);
      }
    }, 0);
  }

  /**
   * Single-answer correct-click binding update: disable all non-correct options,
   * rebuild every binding with fresh refs (selected/highlight from click +
   * history), and persist the selections. Extracted verbatim.
   */
  private applySingleAnswerCorrectBindings(comp: any, index: number, qIdx: number, correctSet: Set<number>): void {
    const disabledSetRef = this.ensureDisabledSet(comp, qIdx);
    disabledSetRef.clear();
    const currentBindings: any[] = Array.isArray(comp.optionBindings())
      ? comp.optionBindings()
      : (typeof comp.optionBindings() === 'function' ? comp.optionBindings() : []);
    for (let i = 0; i < currentBindings.length; i++) {
      if (!correctSet.has(i)) disabledSetRef.add(i);
    }

    const durableClicks = comp._multiSelectByQuestion?.get(qIdx);
    const historySet = new Set<number>(durableClicks ?? []);

    // Replace with NEW array of NEW binding objects so OnPush children re-render.
    const newBindings = currentBindings.map((ob: any, bi: number) => {
      const isCorrectBinding = correctSet.has(bi);
      const isClicked = bi === index;
      const wasPreviouslyClicked = historySet.has(bi) && !isClicked && !isCorrectBinding;
      return {
        ...ob,
        disabled: !isCorrectBinding,
        isSelected: isClicked,
        option: ob?.option ? {
          ...ob.option,
          selected: isClicked,
          highlight: isClicked || wasPreviouslyClicked,
          showIcon: isClicked || wasPreviouslyClicked
        } : ob?.option
      };
    });
    comp.optionBindings.set(newBindings);

    this.persistSingleAnswerSelections(qIdx, index, newBindings, historySet, correctSet);
  }

  /** Persist the single-answer correct selections to sessionStorage + history. */
  private persistSingleAnswerSelections(qIdx: number, index: number, newBindings: any[], historySet: Set<number>, correctSet: Set<number>): void {
    try {
      const toSave: any[] = [];
      for (let bi = 0; bi < newBindings.length; bi++) {
        const nb = newBindings[bi];
        if (!nb?.option) continue;
        const isCorrectBinding = correctSet.has(bi);
        const isClicked = bi === index;
        const wasPreviouslyClicked = historySet.has(bi) && !isClicked && !isCorrectBinding;
        if (isClicked || wasPreviouslyClicked) {
          toSave.push({
            optionId: nb.option.optionId,
            text: nb.option.text,
            displayIndex: bi,
            questionIndex: qIdx,
            selected: isClicked,
            highlight: true,
            showIcon: true,
            correct: isCorrectBinding
          });
        }
      }
      if (toSave.length > 0) {
        sessionStorage.setItem(SK_SEL_Q + qIdx, JSON.stringify(toSave));
        this.selectedOptionService.addToSelectionHistory(qIdx, toSave as any[]);
      }
    } catch (err: unknown) { console.error('processSingleAnswerClick selection-persist failed:', err); }
  }

  private scoreAndOpenFet(comp: any, qIdx: number, displayIdx: number, isMulti: boolean): void {
    try { this.timerService.stopTimer?.(undefined, { force: true, bypassAntiThrash: true }); } catch {}
    this.explanationTextService.fetBypassForQuestion.set(displayIdx, true);
    this.quizService.scoreDirectly(qIdx, true, isMulti);
    this.nextButtonStateService.setNextButtonState(true);
    this.markPerfectAndUnlockFet(comp, displayIdx, isMulti);
  }

  /**
   * Shared post-score tail: mark the question perfect (display-index keyed +
   * sessionStorage), clear the FET lock and unlock the explanation, then emit
   * the show-explanation change. Identical in both process*AnswerClick paths.
   */
  private markPerfectAndUnlockFet(comp: any, displayIdx: number, isMulti: boolean): void {
    // On the MULTI path this is the all-correct branch, so it is completion.
    // On the SINGLE path it means "this one pick resolved correctly", which is
    // not a multi-answer fact at all and belongs to neither map — the legacy
    // union carries it until its readers are migrated.
    if (isMulti) {
      this.quizService.multiAnswerCompletion.set(displayIdx, true);
    }
    this.quizService._multiAnswerPerfect.set(displayIdx, true);
    writeSessionString(SK_MULTI_PERFECT + displayIdx, 'true');
    this.explanationTextService._fetLocked = false;
    this.explanationTextService.unlockExplanation();
    comp.showExplanationChange.emit(true);
  }

  /** Ensure the per-question disabled set exists and return it. Shared pattern. */
  private ensureDisabledSet(comp: any, qIdx: number): Set<number> {
    if (!comp.disabledOptionsPerQuestion.has(qIdx)) {
      comp.disabledOptionsPerQuestion.set(qIdx, new Set<number>());
    }
    return comp.disabledOptionsPerQuestion.get(qIdx)!;
  }

  private writeResolvedFet(displayIdx: number, fetHtml: string, question: any): void {
    this.explanationTextService._activeIndex = displayIdx;
    this.explanationTextService.latestExplanation = fetHtml;
    this.explanationTextService.latestExplanationIndex = displayIdx;
    this.explanationTextService.storeFormattedExplanation(
      displayIdx, fetHtml, question, question?.options ?? [], true
    );
    this.explanationTextService.setExplanationText(fetHtml, {
      force: true,
      context: `question:${displayIdx}`,
      index: displayIdx
    });
    this.explanationTextService.emitFormatted(displayIdx, fetHtml, { bypassGuard: true });
    this.explanationTextService.setShouldDisplayExplanation(true, {
      context: `question:${displayIdx}`,
      force: true
    } as any);
    this.explanationTextService.setIsExplanationTextDisplayed(true, {
      context: `question:${displayIdx}`,
      force: true
    } as any);
    this.explanationTextService.lockExplanation();
    this.quizStateService.setDisplayState({ mode: 'explanation', answered: true });
    // Heading is rendered by the single-source headingHtml computed, which reads
    // the FET text stored above (storeFormattedExplanation/setExplanationText).
    // No direct setHtml needed.
  }

  /**
   * Apply the computed multi-answer binding updates: stamp isSelected/isCorrect/
   * disabled onto fresh binding refs, suppressing disabled on unselected options
   * when the question isn't fully answered yet (Q2/Q4 guard). Verbatim.
   */
  private applyMultiAnswerBindingUpdates(comp: any, bindingUpdates: any[], suppressDisableForUnselected: boolean, durableSet: Set<number>): void {
    comp.optionBindings.set(comp.optionBindings().map((ob: OptionBindings, bi: number) => {
      let disabledFinal = bindingUpdates[bi].disabled;
      if (suppressDisableForUnselected && disabledFinal && !durableSet.has(bi)) {
        disabledFinal = false;
      }
      return {
        ...ob,
        isSelected: bindingUpdates[bi].isSelected,
        isCorrect: bindingUpdates[bi].isCorrect,
        disabled: disabledFinal,
        option: ob.option ? {
          ...ob.option,
          ...bindingUpdates[bi].optionOverrides
        } : ob.option
      };
    }));
  }

  /**
   * Build the multi-answer feedback display from pristine indices (the clicked
   * binding's option can be stale on the 2nd correct click; pristine indices are
   * the source of truth). Sets comp._feedbackDisplay. Verbatim.
   */
  private buildMultiAnswerFeedbackDisplay(comp: any, index: number, binding: any, effectiveCorrectIndices: number[], feedbackText: string): void {
    const correctMessage = this.feedbackService.setCorrectMessage(
      (comp.optionsToDisplay ?? []).filter((o: Option) => o && typeof o === 'object'),
      comp.currentQuestion()!
    );
    const freshOption = comp.optionBindings()?.[index]?.option ?? binding.option;

    // Only ever asks about the option the user just clicked, which is exactly
    // what a verdict discloses for a selection. Membership of a full
    // correct-index set was a much bigger fact than the question needed.
    //
    // `undefined` means no verdict has been recorded for this pick yet, which
    // is not the same as "wrong" — hence the explicit check rather than a
    // truthiness test.
    // REMOVE THE FALLBACK WITH THE IDLE/CHECKING/ERROR CLEANUP.
    const authorizedClicked = selectedVerdictFor(
      this.resolveVerdictStateForComp(comp),
      freshOption?.text
    );
    const isClickedCorrect = authorizedClicked !== undefined
      ? authorizedClicked
      : new Set(effectiveCorrectIndices).has(index);
    comp._feedbackDisplay = {
      idx: index,
      optionId: freshOption?.optionId,
      config: {
        feedback: feedbackText,
        showFeedback: true,
        correctMessage,
        selectedOption: { ...freshOption, correct: isClickedCorrect },
        options: comp.optionsToDisplay ?? [],
        question: comp.currentQuestion() ?? null,
        idx: index
      } as FeedbackProps
    };
    // Deterministic render: _feedbackDisplay is a plain field; force CD so the
    // multi-answer FET re-renders regardless of machine timing (zoneless).
    comp.cdRef?.markForCheck();
  }

  /** The recorded verdict for the question the component is showing, if any. */
  private resolveVerdictStateForComp(comp: any): QuestionVerdictState | null {
    try {
      const quizId = (this.quizService as any)?.quizId as string | undefined;
      const questionText = comp?.currentQuestion?.()?.questionText as string | undefined;
      if (!quizId || !questionText) return null;
      return this.verdicts.verdictFor(quizId, questionText);
    } catch {
      return null;
    }
  }

  /** Push the multi-answer selection message (built from pristine correctness). Verbatim. */
  private pushMultiAnswerSelectionMessage(comp: any, qIdx: number, effectiveCorrectIndices: number[], durableSet: Set<number>): void {
    const optsForMsg: Option[] = comp.optionBindings().map((ob: OptionBindings, bi: number) => ({
      ...ob.option,
      correct: new Set(effectiveCorrectIndices).has(bi),
      selected: durableSet.has(bi),
    })) as Option[];
    const selMsg = this.selectionMessageService.computeFinalMessage({
      index: qIdx,
      total: this.quizService?.totalQuestions() ?? 0,
      qType: QuestionType.MultipleAnswer,
      opts: optsForMsg
    });
    this.selectionMessageService.pushMessage(selMsg, qIdx);
  }

  /**
   * Resolve the live question for an index: prefer the component's current
   * question, then the display-order question at primaryIdx, then the canonical
   * question at qIdx. Shared by the multi-answer pristine helpers.
   */
  private resolveLiveQuestion(comp: any, primaryIdx: number, qIdx: number): any {
    return comp.currentQuestion()
      ?? this.quizService?.getQuestionsInDisplayOrder?.()?.[primaryIdx]
      ?? this.quizService?.questions?.[qIdx];
  }

  /**
   * Whether every pristine-correct option for the question is in the durable
   * selection set — counted by TEXT match against quizInitialState (bypasses
   * index mismatches between effectiveCorrectIndices and the real count). Verbatim.
   */
  private computeAllCorrectInDurable(comp: any, qIdx: number, displayIdx: number, durableSet: Set<number>, effectiveCorrectIndices: number[]): boolean {
    let allCorrectInDurable = effectiveCorrectIndices.length > 0 &&
      effectiveCorrectIndices.every((ci: number) => durableSet.has(ci));
    try {
      const liveQAC: any = this.resolveLiveQuestion(comp, displayIdx, qIdx);
      const bindingsAC: any[] = comp.optionBindings() ?? [];
      if (bindingsAC.length) {
        // WHICH OPTIONS COUNT AS SELECTED — unchanged, and load-bearing.
        //
        // The live durable set UNION the cross-visit snapshot. durableSet resets
        // on navigation, so on a REVISIT it holds only the just-clicked option;
        // folding in uiSelectedTexts is what lets a COMPLETING click on revisit
        // register as all-correct. Distinct texts (not a counter) keep a partial
        // from ever reaching the full count.
        const selectedTexts = new Set<string>();
        for (const selIdx of durableSet) {
          const txt = norm(bindingsAC[selIdx]?.option?.text);
          if (txt) selectedTexts.add(txt);
        }
        for (const t of this.selectedOptionService.uiSelectedTextsForQuestion(displayIdx) ?? []) {
          const n = norm(t);
          if (n) selectedTexts.add(n);
        }

        // AUTHORIZED PATH.
        //
        // This asks for PERFECT, not the verdict's own correct/incorrect: every
        // required answer present AND nothing wrong picked. `isResolvedCorrect`
        // alone is the audited SUPERSET rule and would call "2 correct + 1
        // wrong" perfect — which drops the red incorrect repaint on revisit that
        // the no-incorrect guard exists to preserve.
        //
        // Both halves are facts about the user's OWN selections, so nothing here
        // asks about an option they never touched.
        const quizId = (this.quizService as any)?.quizId as string | undefined;
        const questionText = liveQAC?.questionText as string | undefined;
        const state = quizId && questionText
          ? this.verdicts.verdictFor(quizId, questionText)
          : null;

        const authorizedAll = allCorrectSelectedFromVerdict(state);
        if (authorizedAll !== null) {
          const anyWrongPicked = [...selectedTexts].some(
            (t) => selectedVerdictFor(state, t) === false
          );
          return authorizedAll && !anyWrongPicked;
        }

        // REMOVE WITH THE IDLE/CHECKING/ERROR CLEANUP — reached only when no
        // verdict has been recorded. A revisit in a fresh session has none, and
        // absence is not a negative verdict, so the pristine comparison still
        // answers here.
        const pristineCorrectTextsAC =
          this.quizService.getPristineCorrectTextsForQuestion(questionText);
        if (pristineCorrectTextsAC.size > 0) {
          const selectedCorrectTexts = new Set<string>();
          let hasIncorrectSelected = false;
          for (const t of selectedTexts) {
            if (pristineCorrectTextsAC.has(t)) selectedCorrectTexts.add(t);
            else hasIncorrectSelected = true;
          }
          allCorrectInDurable =
            selectedCorrectTexts.size >= pristineCorrectTextsAC.size && !hasIncorrectSelected;
        }
      }
    } catch (err: unknown) { console.error('processMultiAnswerClick allCorrectInDurable check failed:', err); }
    return allCorrectInDurable;
  }

  /**
   * Repaint every binding once the question is authorized-complete: correct
   * options enabled and active, the rest disabled.
   *
   * ── Why this waits for the verdict ─────────────────────────────────
   *
   * This used to run from the click, taking a correct-index set built at click
   * time. Under the API adapter the check is still in flight then — the phase is
   * `checking`, so nothing is authorized — which meant the indices came from the
   * local bank. The repaint was only ever synchronous BECAUSE the answer key was
   * in the browser, so it could not have survived the key's removal.
   *
   * It now runs when the terminal verdict lands, where `correctOptionTexts` is
   * the authorized reveal. Correct options are matched by TEXT, so shuffling or
   * any reordering of the display cannot misplace the repaint.
   */
  private respreadBindingsOnAllCorrect(comp: any, correctTexts: ReadonlySet<string>): void {
    queueMicrotask(() => {
      comp.optionBindings.set((comp.optionBindings() ?? []).map((b: OptionBindings) => {
        const isCorrectOption = correctTexts.has(norm((b.option as any)?.text));
        return {
          ...b,
          disabled: !isCorrectOption,
          isCorrect: isCorrectOption,
          option: b.option ? {
            ...b.option,
            active: isCorrectOption
          } : b.option
        };
      }));
      comp.cdRef.detectChanges();
    });
  }

  /**
   * Repaint now if the verdict is already terminal, otherwise when it arrives.
   *
   * Both branches are real. The API adapter leaves the check in flight across
   * the whole click, so the repaint is deferred; the local adapter resolves
   * during the same click, BEFORE this runs, so its arrival event has already
   * been and gone — subscribing alone would wait for something that will never
   * come again.
   */
  private scheduleTerminalRespread(comp: any): void {
    const quizId = (this.quizService as any)?.quizId as string | undefined;
    const questionText = comp?.currentQuestion?.()?.questionText as string | undefined;
    if (!quizId || !questionText) return;

    const already = this.verdicts.verdictFor(quizId, questionText);
    if (this.shouldRespreadForVerdict(already)) {
      this.respreadFromVerdict(comp, questionText, already);
      return;
    }

    // ONE pending wait per question. Every click on an unfinished multi-answer
    // question passes through here, and without this the completing verdict
    // would be answered by one subscription per click.
    const key = `${quizId} ${norm(questionText)}`;
    if (this.pendingRespreads.has(key)) return;

    const sub = this.verdicts.terminalVerdicts$
      .pipe(
        filter((e) => e.quizId === quizId && norm(e.questionText) === norm(questionText)),
        take(1)
      )
      .subscribe((e) => {
        this.pendingRespreads.delete(key);
        if (this.shouldRespreadForVerdict(e.state)) {
          this.respreadFromVerdict(comp, questionText, e.state);
        }
      });

    if (sub.closed) this.pendingRespreads.delete(key);
    else this.pendingRespreads.set(key, sub);
  }

  /**
   * The old gate, expressed in authorized terms.
   *
   * `computeAllCorrectInDurable` asked for PERFECT rather than the superset
   * rule — every correct option selected AND nothing wrong — because a wrong
   * pick must keep its red repaint instead of being greyed out with the losers.
   * That distinction is preserved here deliberately.
   */
  private shouldRespreadForVerdict(state: QuestionVerdictState | null): boolean {
    if (!state || state.phase !== 'resolved') return false;
    if (state.isResolvedCorrect !== true) return false;

    for (const [, correct] of state.selectedVerdicts) {
      if (correct === false) return false;
    }
    return true;
  }

  /** Repaint, unless the component has moved on to another question. */
  private respreadFromVerdict(comp: any, questionText: string, state: QuestionVerdictState): void {
    // STALE GUARD, second layer. The verdict service already drops a response
    // that lost its generation race; this covers the other direction — a
    // response still current for ITS question arriving after the user has
    // navigated to a different one.
    const showing = comp?.currentQuestion?.()?.questionText as string | undefined;
    if (!showing || norm(showing) !== norm(questionText)) return;

    this.respreadBindingsOnAllCorrect(
      comp,
      new Set(state.correctOptionTexts.map((t) => norm(t)))
    );
  }

  /**
   * PRISTINE-AUTHORITATIVE recompute of the correct-option indices from
   * quizInitialState (upstream bindings can have mutated/missing correct flags).
   * Returns the rebuilt indices only when they cover at least as many as we
   * had (avoid pathological text-match failures), else the input. Verbatim.
   */
  private recomputeEffectiveCorrectIndices(comp: any, qIdx: number, effectiveCorrectIndices: number[]): number[] {
    try {
      const liveQ: any = this.resolveLiveQuestion(comp, qIdx, qIdx);
      const bindings: any[] = comp.optionBindings() ?? [];
      if (bindings.length) {
        const pristineCorrectTexts =
          this.quizService.getPristineCorrectTextsForQuestion(liveQ?.questionText);
        if (pristineCorrectTexts.size > 0) {
          const rebuilt: number[] = [];
          for (let i = 0; i < bindings.length; i++) {
            if (pristineCorrectTexts.has(norm(bindings[i]?.option?.text))) {
              rebuilt.push(i);
            }
          }
          if (rebuilt.length >= effectiveCorrectIndices.length && rebuilt.length > 0) {
            return rebuilt;
          }
        }
      }
    } catch (err: unknown) { console.error('processMultiAnswerClick pristine-recompute failed:', err); }
    return effectiveCorrectIndices;
  }

  /**
   * Q2/Q4 GUARD: when pristine has more correct than the user has selected,
   * suppress disabled=true on bindings other than the clicked-incorrect one(s)
   * so they can still pick the remaining correct answer. Verbatim.
   */
  private computeSuppressDisableForUnselected(comp: any, qIdx: number, displayIdx: number, durableSet: Set<number>): boolean {
    try {
      const liveQS: any = this.resolveLiveQuestion(comp, displayIdx, qIdx);
      const pristineCorrectTextsS =
        this.quizService.getPristineCorrectTextsForQuestion(liveQS?.questionText);
      if (pristineCorrectTextsS.size > 1) {
        const bindingsS: any[] = comp.optionBindings() ?? [];
        let selectedCorrectS = 0;
        for (const sIdx of durableSet) {
          if (pristineCorrectTextsS.has(norm(bindingsS[sIdx]?.option?.text))) {
            selectedCorrectS++;
          }
        }
        if (selectedCorrectS < pristineCorrectTextsS.size) {
          return true;
        }
      }
    } catch (err: unknown) { console.error('processMultiAnswerClick suppressDisable-guard failed:', err); }
    return false;
  }

  processMultiAnswerClick(params: {
    comp: any;
    index: number;
    binding: any;
    qIdx: number;
    displayIdx: number;
    durableSet: Set<number>;
    effectiveCorrectIndices: number[];
    effectiveCorrectCount: number;
    isShuffled: boolean;
  }): void {
    const { comp, index, binding, qIdx, displayIdx, durableSet, isShuffled } = params;
    let { effectiveCorrectIndices } = params;

    effectiveCorrectIndices = this.recomputeEffectiveCorrectIndices(comp, qIdx, effectiveCorrectIndices);

    const { clickState, bindingUpdates } =
      this.applyMultiAnswerDisableState(comp, index, qIdx, displayIdx, durableSet, effectiveCorrectIndices);

    const suppressDisableForUnselected = this.computeSuppressDisableForUnselected(comp, qIdx, displayIdx, durableSet);
    this.applyMultiAnswerBindingUpdates(comp, bindingUpdates, suppressDisableForUnselected, durableSet);

    const feedbackText = this.clickHandler.generateMultiAnswerFeedbackText(clickState);
    this.buildMultiAnswerFeedbackDisplay(comp, index, binding, effectiveCorrectIndices, feedbackText);
    this.pushMultiAnswerSelectionMessage(comp, qIdx, effectiveCorrectIndices, durableSet);

    // All correct selected? (pristine TEXT-match count, not index-based.)
    const allCorrectInDurable = this.computeAllCorrectInDurable(comp, qIdx, displayIdx, durableSet, effectiveCorrectIndices);
    if (allCorrectInDurable) {
      this.emitMultiAnswerFetOnAllCorrect(comp, qIdx, displayIdx, effectiveCorrectIndices, isShuffled);
    }

    this.restoreFeedbackDisplayAfterCD(comp);
    comp.showFeedback.set(true);
    comp.cdRef.detectChanges();

    // NOT gated on `allCorrectInDurable`: that decision is made at click time,
    // when nothing is authorized yet, so it still answers from the local bank.
    // The verdict decides both WHETHER and WHAT to repaint, so this only has to
    // register the intent to repaint.
    this.scheduleTerminalRespread(comp);

    this.triggerAllIncorrectsExhaustedAutoReveal(comp, index, qIdx, displayIdx);
  }

  /**
   * Compute the multi-answer click state, update the durable disabled set, mark
   * the question complete when all correct are now selected (before bindings, so
   * isDisabled() sees it), and compute the binding updates.
   *
   * ── Where these facts come from ────────────────────────────────────
   *
   * This used to take a full correct-index set and read every answer off it,
   * including options the user never touched. The verdict answers the same
   * questions with strictly less: a selection carries its own verdict, the
   * number of still-missing correct answers arrives WITHOUT naming them, and
   * the full set is disclosed only once the question is terminal — which is the
   * one moment this function actually needs it, to grey out the losers.
   *
   * COMPLETION, NOT PERFECT. `remaining` counts only MISSING correct answers,
   * so extra wrong picks still leave it at zero. That is the audited superset
   * rule, and it is exactly what the old index arithmetic did
   * (`correctIndices.length - correctSelected`), so the `_multiAnswerPerfect`
   * stamp keeps firing on the same clicks as before despite its name.
   */
  private applyMultiAnswerDisableState(comp: any, index: number, qIdx: number, displayIdx: number, durableSet: Set<number>, effectiveCorrectIndices: number[]): { clickState: any; bindingUpdates: any[] } {
    const bindings: any[] = comp.optionBindings() ?? [];
    const authorized = this.authorizedMultiAnswerFacts(
      this.resolveVerdictStateForComp(comp), bindings, index, durableSet
    );

    // REMOVE WITH THE IDLE/CHECKING/ERROR CLEANUP — the pre-verdict path. Note
    // the fallback is all-or-nothing: facts are never mixed across authorities.
    const clickState = authorized?.clickState
      ?? this.clickHandler.computeMultiAnswerClickState(index, durableSet, effectiveCorrectIndices);
    const correctIdxs = authorized ? authorized.correctIndices : effectiveCorrectIndices;

    const disabledSetRef = this.ensureDisabledSet(comp, qIdx);
    this.clickHandler.updateDisabledSet(
      disabledSetRef, index, clickState.isClickedCorrect,
      clickState.remaining, bindings.length, correctIdxs
    );

    if (clickState.remaining === 0) {
      // COMPLETION, not perfect: `remaining` counts only MISSING correct
      // answers, so a wrong extra still leaves it at zero.
      this.quizService.multiAnswerCompletion.set(displayIdx, true);
      this.quizService._multiAnswerPerfect.set(displayIdx, true);
      writeSessionString(SK_MULTI_PERFECT + displayIdx, 'true');
    }

    const bindingUpdates = authorized
      ? this.buildAuthorizedBindingUpdates(bindings, durableSet, disabledSetRef, authorized.correctnessOf)
      : this.clickHandler.computeMultiAnswerBindingUpdates(
          bindings.length, durableSet, effectiveCorrectIndices, disabledSetRef
        );
    return { clickState, bindingUpdates };
  }

  /**
   * The multi-answer facts taken from the verdict, or null when the question
   * carries no usable one yet (idle/checking/error, or a state that cannot
   * answer for the clicked option) so the caller can fall back wholesale.
   *
   * Returning null rather than guessing is the point: an unchecked pick is not
   * a wrong pick.
   */
  private authorizedMultiAnswerFacts(
    state: QuestionVerdictState | null,
    bindings: any[],
    clickedIndex: number,
    durableSet: Set<number>
  ): { clickState: any; correctIndices: number[]; correctnessOf: (bi: number) => boolean | null } | null {
    const completed = allCorrectSelectedFromVerdict(state);
    if (!state || completed === null) return null;

    // TERMINAL ONLY. `correctOptionTexts` is empty for the whole of incomplete
    // play, so during partial selection there is no full set to read even here.
    const revealed = state.phase === 'resolved' || state.phase === 'expired'
      ? new Set(state.correctOptionTexts.map((t) => norm(t)))
      : null;

    const correctnessOf = (bi: number): boolean | null => {
      const text = bindings[bi]?.option?.text;
      if (revealed) return revealed.has(norm(text ?? ''));
      const own = selectedVerdictFor(state, text);
      return own !== undefined ? own : null;
    };

    // The clicked option is the one thing this must be sure about — it decides
    // whether the pick gets disabled. Unknown means defer, not "wrong".
    const clickedCorrect = correctnessOf(clickedIndex);
    if (clickedCorrect === null) return null;

    let remaining: number;
    if (completed) {
      remaining = 0;
    } else if (typeof state.remainingCorrectCount === 'number' && state.remainingCorrectCount > 0) {
      remaining = state.remainingCorrectCount;
    } else {
      return null;  // not complete, yet cannot say what is outstanding
    }

    const correctIndices: number[] = [];
    if (revealed) {
      for (let bi = 0; bi < bindings.length; bi++) {
        if (correctnessOf(bi) === true) correctIndices.push(bi);
      }
    }

    let correctSelected = 0;
    let incorrectSelected = 0;
    for (const selIdx of durableSet) {
      const known = correctnessOf(selIdx);
      if (known === true) correctSelected++;
      else if (known === false) incorrectSelected++;
    }

    return {
      clickState: {
        clickedIndex,
        isClickedCorrect: clickedCorrect,
        correctSelected,
        incorrectSelected,
        remaining,
        correctIndices1Based: correctIndices.map((i) => i + 1)
      },
      correctIndices,
      correctnessOf
    };
  }

  /**
   * Per-binding updates with TRI-STATE correctness: an option that has neither
   * been picked nor been revealed stays unknown instead of being told it is
   * wrong. Consumers already test `=== true` for this reason — see
   * OptionBindings.isCorrect and option-lock-policy.applyAuthorizedCorrectness,
   * whose shape this mirrors.
   *
   * `highlight`/`showIcon` follow SELECTION only, exactly as before, so nothing
   * an untouched option renders depends on what the answer key says.
   */
  private buildAuthorizedBindingUpdates(
    bindings: any[],
    durableSet: Set<number>,
    disabledSet: Set<number>,
    correctnessOf: (bi: number) => boolean | null
  ): any[] {
    const updates: any[] = [];
    for (let bi = 0; bi < bindings.length; bi++) {
      const isInDurable = durableSet.has(bi);
      const known = correctnessOf(bi);
      updates.push({
        isSelected: isInDurable,
        isCorrect: known,
        disabled: disabledSet.has(bi),
        optionOverrides: {
          // Undefined, not false: this clears the bank's own flag off the copy
          // so it cannot stand in for a verdict that has not been given.
          correct: known ?? undefined,
          selected: isInDurable,
          highlight: isInDurable,
          showIcon: isInDurable
        }
      });
    }
    return updates;
  }

  /** Restore _feedbackDisplay after the synchronous CD pass clears it (microtask). */
  private restoreFeedbackDisplayAfterCD(comp: any): void {
    const savedFeedback = comp._feedbackDisplay;
    queueMicrotask(() => {
      comp._feedbackDisplay = savedFeedback;
      comp.cdRef.detectChanges();
    });
  }

  /**
   * Processes a single-answer option click: pristine correctness check,
   * FET emission, timer stop, option disable/highlight, session persistence.
   */
  processSingleAnswerClick(params: {
    comp: any;
    index: number;
    qIdx: number;
    displayIdx: number;
    durableSet: Set<number>;
    effectiveCorrectIndices: number[];
    isShuffled: boolean;
  }): void {
    // `effectiveCorrectIndices` stays on the params type because the
    // multi-answer route below still consumes it; the single-answer path no
    // longer needs it at all.
    const { comp, index, qIdx, displayIdx, isShuffled } = params;

    // If pristine data says this is multi-answer, route there instead (avoids
    // locking the remaining options before the 2nd correct is picked).
    if (this.routeToMultiIfPristineMulti(params)) return;

    if (this.isSingleAnswerClickCorrect(comp, index, qIdx, displayIdx, isShuffled)) {
      // THE CORRECT SET IS THE CLICK.
      //
      // A single-answer question has exactly one correct option — a
      // multi-answer one was routed away above — and we only reach here
      // because the clicked option is that one. So scanning the bank to
      // rediscover it answered a question we had already answered.
      //
      // It was also a latent break: with correctness absent from the options
      // (the shape /questions returns) the scan produced an EMPTY set, and
      // `disabled: !isCorrectBinding` would then have disabled every option
      // including the user's correct pick.
      this.handleSingleAnswerCorrect(comp, index, qIdx, displayIdx, new Set([index]));
      return;
    }

    // All-incorrects-exhausted auto-reveal (shared helper).
    this.triggerAllIncorrectsExhaustedAutoReveal(comp, index, qIdx, displayIdx);
  }

  /**
   * If pristine data says the question is actually multi-answer, route the click
   * through processMultiAnswerClick (which only locks incorrects after all
   * correct are selected) and return true. Verbatim from the single-answer guard.
   */
  private routeToMultiIfPristineMulti(params: {
    comp: any; index: number; qIdx: number; displayIdx: number;
    durableSet: Set<number>; effectiveCorrectIndices: number[]; isShuffled: boolean;
  }): boolean {
    const { comp, index, qIdx, displayIdx, durableSet, effectiveCorrectIndices, isShuffled } = params;
    try {
      const liveQText = comp.currentQuestion()?.questionText
        ?? this.quizService?.getQuestionsInDisplayOrder?.()?.[displayIdx]?.questionText
        ?? this.quizService?.questions?.[qIdx]?.questionText;
      const pristineCorrectTexts =
        this.quizService.getPristineCorrectTextsForQuestion(liveQText);
      const pristineCorrectCount = pristineCorrectTexts.size;
      if (pristineCorrectCount > 1) {
        const correctIndicesByText: number[] = [];
        const bindings: any[] = comp.optionBindings() ?? [];
        for (let i = 0; i < bindings.length; i++) {
          if (pristineCorrectTexts.has(norm(bindings[i]?.option?.text))) {
            correctIndicesByText.push(i);
          }
        }
        this.processMultiAnswerClick({
          comp,
          index,
          binding: comp.optionBindings()?.[index],
          qIdx,
          displayIdx,
          durableSet,
          effectiveCorrectIndices: correctIndicesByText.length
            ? correctIndicesByText
            : effectiveCorrectIndices,
          effectiveCorrectCount: correctIndicesByText.length || pristineCorrectCount,
          isShuffled
        });
        return true;
      }
    } catch (err: unknown) { console.error('processSingleAnswerClick multi-answer guard failed:', err); }
    return false;
  }

  /**
   * Single-answer correct click: score + open FET gates, resolve the question,
   * emit the FET, apply the correct-bindings, and run CD. Extracted verbatim.
   */
  private handleSingleAnswerCorrect(comp: any, index: number, qIdx: number, displayIdx: number, correctSet: Set<number>): void {
    this.scoreAndOpenFet(comp, qIdx, displayIdx, false);

    const singleFetQuestion = comp.currentQuestion()
      ?? comp.getQuestionAtDisplayIndex?.(displayIdx)
      ?? this.quizService?.getQuestionsInDisplayOrder?.()?.[displayIdx];

    this.emitSingleAnswerFet(comp, displayIdx, singleFetQuestion);
    this.applySingleAnswerCorrectBindings(comp, index, qIdx, correctSet);
    comp.cdRef?.detectChanges?.();
  }

  /**
   * AUTO-REVEAL helper: when the user has selected every incorrect option
   * for the given question, auto-highlight every canonical correct option,
   * emit FET, and stop the timer. Works for both single- and multi-answer
   * questions — the size of pristineCorrectTextsAR can be 1 (single) or N
   * (multi). Score is NOT incremented (user didn't fully pick correctly).
   *
   * Called from both processSingleAnswerClick (incorrect-click tail) and
   * processMultiAnswerClick to share a single auto-reveal implementation.
   */
  private triggerAllIncorrectsExhaustedAutoReveal(comp: any, index: number, qIdx: number, displayIdx: number): void {
    try {
      const ctxAR = this.computeAutoRevealContext(comp, index, qIdx);
      if (!ctxAR) return;
      const { bindingsAR, bindingNormsAR, pristineCorrectTextsAR, isMultiModeAR } = ctxAR;

      // All incorrects exhausted — auto-reveal the correct answer(s).
      const { correctIdxsAR, correctSetAR, historySetAR } =
        this.enterAutoRevealState(comp, index, qIdx, displayIdx, bindingsAR, bindingNormsAR, pristineCorrectTextsAR);

      // Resolve and emit the FET text FIRST while bindings are still
      // stable. The binding rebuild below must be synchronous (not
      // deferred via queueMicrotask) because detectChanges() triggers
      // effects that can overwrite the bindings before the microtask
      // runs — wiping _autoRevealedCorrect and the green highlight.
      const fetQuestionAR = comp.currentQuestion()
        ?? comp.getQuestionAtDisplayIndex?.(displayIdx)
        ?? this.quizService?.getQuestionsInDisplayOrder?.()?.[displayIdx];
      const fetTextAR = this.resolveAutoRevealFetText(comp, displayIdx, correctIdxsAR, isMultiModeAR, fetQuestionAR);

      // Shared FET write (same sequence as the process*AnswerClick paths).
      if (fetTextAR) {
        this.writeResolvedFet(displayIdx, fetTextAR, fetQuestionAR);
      }

      // Synchronous binding rebuild — MUST happen after FET emission and NOT be
      // deferred (detectChanges() effects would overwrite deferred bindings,
      // wiping _autoRevealedCorrect).
      this.applyAutoRevealBindings(comp, bindingsAR, correctSetAR, historySetAR, index);

      setTimeout(() => {
        try { comp.emitExplanation?.(qIdx, true); } catch { /* ignore */ }
      }, 0);

      comp.cdRef?.detectChanges?.();
    } catch (err: unknown) { console.error('auto-reveal failed:', err); }
  }

  /**
   * Detection phase for the all-incorrects-exhausted auto-reveal. Returns the
   * binding context when every incorrect option has been selected (the trigger
   * condition), or null to bail out. Extracted verbatim.
   */
  private computeAutoRevealContext(comp: any, index: number, qIdx: number):
    { bindingsAR: any[]; bindingNormsAR: string[]; pristineCorrectTextsAR: Set<string>; isMultiModeAR: boolean } | null {
    const liveQAR: any = comp.currentQuestion()
      ?? this.quizService?.getQuestionsInDisplayOrder?.()?.[qIdx]
      ?? this.quizService?.questions?.[qIdx];
    const bindingsAR: any[] = Array.isArray(comp.optionBindings())
      ? comp.optionBindings()
      : (typeof comp.optionBindings() === 'function' ? comp.optionBindings() : []);
    if (!bindingsAR.length) return null;

    // Pre-compute normalized texts for all bindings (avoids repeated
    // norm() calls in the multiple loops below).
    const bindingNormsAR: string[] = bindingsAR.map(
      (b: any) => norm(b?.option?.text)
    );

    // Pristine correct text(s) from cache. Must have at least one
    // canonical correct option to reveal.
    const pristineCorrectTextsAR =
      this.quizService.getPristineCorrectTextsForQuestion(liveQAR?.questionText);
    if (pristineCorrectTextsAR.size < 1) return null;
    const isMultiModeAR = pristineCorrectTextsAR.size > 1;

    // Collect every selected text for this question. For single-answer,
    // selectedOptionsMap holds only the latest click (each click replaces
    // the previous), so we MUST read from comp._multiSelectByQuestion —
    // a Set<number> of every clicked binding index for this qIdx.
    const selectedTextsAR = new Set<string>();
    const durableClicksAR0: Set<number> | undefined =
      comp._multiSelectByQuestion?.get(qIdx);
    if (durableClicksAR0) {
      for (const ci of durableClicksAR0) {
        const tx = bindingNormsAR[ci];
        if (tx) selectedTextsAR.add(tx);
      }
    }
    // Belt-and-suspenders: also include the just-clicked option in case
    // the durable set hasn't been populated yet on this CD cycle.
    const clickedTextAR = bindingNormsAR[index] ?? norm(comp.optionBindings()?.[index]?.option?.text);
    if (clickedTextAR) selectedTextsAR.add(clickedTextAR);
    // And merge any in-memory map entries.
    const selectionsAR =
      this.selectedOptionService.getSelectedOptionsForQuestion(qIdx) ?? [];
    for (const s of selectionsAR) {
      const tx = norm(s?.text);
      if (tx) selectedTextsAR.add(tx);
    }

    // Build the set of incorrect bindings by text — option whose text is
    // not in the pristine correct set.
    const incorrectTextsAR = new Set<string>();
    for (let i = 0; i < bindingsAR.length; i++) {
      const tx = bindingNormsAR[i];
      if (tx && !pristineCorrectTextsAR.has(tx)) incorrectTextsAR.add(tx);
    }
    if (incorrectTextsAR.size === 0) return null;
    const allIncorrectSelected =
      [...incorrectTextsAR].every(t => selectedTextsAR.has(t));
    if (!allIncorrectSelected) return null;

    return { bindingsAR, bindingNormsAR, pristineCorrectTextsAR, isMultiModeAR };
  }

  /**
   * Reveal-state phase: stop the timer, open the next button + explanation,
   * and compute the correct/disabled/history index sets used to rebuild the
   * bindings. Extracted verbatim.
   */
  private enterAutoRevealState(comp: any, index: number, qIdx: number, displayIdx: number, bindingsAR: any[], bindingNormsAR: string[], pristineCorrectTextsAR: Set<string>):
    { correctIdxsAR: number[]; correctSetAR: Set<number>; historySetAR: Set<number> } {
    try { this.timerService.stopTimer?.(undefined, { force: true, bypassAntiThrash: true }); } catch {}
    this.nextButtonStateService.setNextButtonState(true);
    this.selectionMessageService.forceNextButtonMessage(qIdx);
    this.explanationTextService.fetBypassForQuestion.set(displayIdx, true);
    // INTENTIONALLY do NOT set _multiAnswerPerfect — see comment in
    // sibling autoreveal block (~line 711). Used as the navigation-clear
    // gate, so setting it on autoreveal-fired (user picked wrong) made
    // Q2 retain green correct-option highlight on 2nd visit.

    // Unlock the explanation BEFORE setting new FET — without this,
    // a previous question's lockExplanation() would silently swallow
    // setExplanationText() calls and the FET would never display.
    this.explanationTextService._fetLocked = false;
    this.explanationTextService.unlockExplanation();
    // Emit early so the explanation panel becomes visible before we
    // resolve and write the text (mirrors processMultiAnswerClick's
    // all-correct-selected path at line 246).
    comp.showExplanationChange.emit(true);

    // Highlight the canonical correct option(s) + disable everything else.
    const correctIdxsAR: number[] = [];
    for (let bi = 0; bi < bindingsAR.length; bi++) {
      const tx = bindingNormsAR[bi];
      if (tx && pristineCorrectTextsAR.has(tx)) correctIdxsAR.push(bi);
    }

    if (!comp.disabledOptionsPerQuestion.has(qIdx)) {
      comp.disabledOptionsPerQuestion.set(qIdx, new Set<number>());
    }
    const disabledSetAR = comp.disabledOptionsPerQuestion.get(qIdx)!;
    const correctSetAR = new Set(correctIdxsAR);
    disabledSetAR.clear();
    for (let i = 0; i < bindingsAR.length; i++) {
      if (!correctSetAR.has(i)) disabledSetAR.add(i);
    }

    const durableClicksAR = comp._multiSelectByQuestion?.get(qIdx);
    const historySetAR = new Set<number>(durableClicksAR ?? []);
    historySetAR.add(index);

    return { correctIdxsAR, correctSetAR, historySetAR };
  }

  /**
   * Resolve the auto-reveal FET text (via the shared-option explanation service,
   * falling back to the question's explanation), and for multi-answer format it
   * as the "Options X and Y..." form. Extracted verbatim.
   */
  private resolveAutoRevealFetText(comp: any, displayIdx: number, correctIdxsAR: number[], isMultiModeAR: boolean, fetQuestionAR: any): string {
    const fetCtxAR = {
      resolvedIndex: displayIdx,
      question: fetQuestionAR,
      currentQuestion: comp.currentQuestion(),
      quizId: comp.quizId?.() ?? comp.quizId ?? '',
      optionBindings: comp.optionBindings() ?? [],
      optionsToDisplay: comp.optionsToDisplay ?? [],
      isMultiMode: isMultiModeAR
    };
    let fetTextAR = '';
    try {
      fetTextAR = this.sharedOptionExplanationService.resolveExplanationText(fetCtxAR as any)?.trim()
        || fetQuestionAR?.explanation || '';
    } catch { /* ignore */ }

    if (isMultiModeAR && fetTextAR) {
      try {
        const oneBasedIndices = correctIdxsAR
          .map((ci: number) => ci + 1)
          .filter((n: number) => Number.isFinite(n) && n > 0);
        if (fetQuestionAR && oneBasedIndices.length > 0) {
          fetTextAR = this.explanationTextService.formatExplanation(
            fetQuestionAR,
            oneBasedIndices,
            fetTextAR
          );
        }
      } catch (err: unknown) { console.error('triggerAllIncorrectsExhausted FET formatting failed:', err); }
    }
    return fetTextAR;
  }

  /**
   * Rebuild bindings for auto-reveal: highlight the canonical correct option(s)
   * (_autoRevealedCorrect + correct-option class), keep the clicked option
   * selected, and disable the rest. Synchronous. Extracted verbatim.
   */
  private applyAutoRevealBindings(comp: any, bindingsAR: any[], correctSetAR: Set<number>, historySetAR: Set<number>, index: number): void {
    comp.optionBindings.set(bindingsAR.map((ob: any, bi: number) => {
      const isCorrectBinding = correctSetAR.has(bi);
      const isClicked = bi === index;
      const wasPreviouslyClicked = historySetAR.has(bi) && !isClicked && !isCorrectBinding;
      return {
        ...ob,
        disabled: !isCorrectBinding && !isClicked,
        isSelected: isClicked,
        isCorrect: isCorrectBinding,
        _autoRevealedCorrect: isCorrectBinding,
        option: ob?.option ? {
          ...ob.option,
          selected: isClicked,
          highlight: isClicked || wasPreviouslyClicked || isCorrectBinding,
          showIcon: isClicked || wasPreviouslyClicked || isCorrectBinding,
          active: isCorrectBinding,
          _autoRevealedCorrect: isCorrectBinding
        } : ob?.option,
        cssClasses: {
          ...(ob?.cssClasses || {}),
          'correct-option': isCorrectBinding,
          'incorrect-option': !isCorrectBinding && (isClicked || wasPreviouslyClicked)
        }
      };
    }));
  }

}