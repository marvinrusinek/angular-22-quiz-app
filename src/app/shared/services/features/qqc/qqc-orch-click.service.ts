import { Service, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { filter, take } from 'rxjs/operators';

import { QuestionType } from '../../../models/question-type.enum';

import { Option } from '../../../models/Option.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';

import type { QuizQuestionComponent } from '../../../../components/question/quiz-question/quiz-question.component';
import { QuestionVerdictService } from '../verdict/question-verdict.service';
import type { QuestionVerdictState } from '../verdict/question-verdict.types';
import {
  selectedVerdictFor,
  verdictStateForDisplayIndex
} from '../verdict/authorized-correctness';
import { isOptionCorrect } from '../../../utils/is-option-correct';
import { norm } from '../../../utils/text-norm';
import { swallow } from '../../../utils/error-logging';

type Host = QuizQuestionComponent;

/**
 * Orchestrates QQC option click handling.
 * Extracted from QqcComponentOrchestratorService.
 */
@Service()
export class QqcOrchClickService {
  private readonly verdicts = inject(QuestionVerdictService);

  async runOnOptionClicked(
    host: Host,
    event: { option: any; index: number; checked: boolean; wasReselected?: boolean }
  ): Promise<void> {
    const ctx = await this.prepareOptionClick(host, event);
    if (!ctx) return;
    const { idx, q, evtIdx, evtOpt } = ctx;

    try {
      const { selOptsSetImmediate, isMultiForSelection, allCorrect } =
        this.runSyncClickFlow(host, q, idx, evtIdx, evtOpt, event.checked);

      host.updateOptionHighlighting(selOptsSetImmediate);
      host.refreshFeedbackFor(evtOpt ?? undefined);
      this.applySingleAnswerDisable(host, idx, q, evtOpt, evtIdx);
      host.cdRef.markForCheck();

      this.maybeTriggerMultiAnswerFet(host, idx, q, allCorrect, isMultiForSelection);

      this.scheduleImmediateClickUpdate(host, idx, q, evtOpt, evtIdx, selOptsSetImmediate);
      this.schedulePostClickRaf(host, idx, q, evtOpt, evtIdx, event);
      this.scheduleDeferredDisable(host, idx, q, evtOpt, evtIdx);
    } finally {
      this.scheduleClickGateRelease(host, q, evtOpt);
    }
  }

  /**
   * Pre-flight: reset flags, await interaction-ready, resolve the click context,
   * and acquire the click gate. Returns null when the click should be ignored
   * (not ready / no option / locked / gate held). Extracted verbatim.
   */
  private async prepareOptionClick(
    host: Host,
    event: { option: any; index: number; checked: boolean; wasReselected?: boolean }
  ): Promise<{ idx: number; q: QuizQuestion | null; evtIdx: number; evtOpt: any } | null> {
    host._skipNextAsyncUpdates = false;

    if (host._pendingRAF != null) {
      cancelAnimationFrame(host._pendingRAF);
      host._pendingRAF = null;
    }

    if (!host.quizStateService.isInteractionReady()) {
      await firstValueFrom(
        host.quizStateService.interactionReady$.pipe(filter(Boolean), take(1))
      );
    }

    if (!host.currentQuestion() || !host.currentOptions) return null;

    const idx = host.quizService.getCurrentQuestionIndex() ?? 0;
    const q = host.quizService.getQuestionsInDisplayOrder?.()?.[idx]
      ?? host.questions()?.[idx];
    const evtIdx = event.index;
    const evtOpt = event.option;

    host.explanationDisplay.resetExplanationStateForClick(idx);

    if (evtOpt == null) return null;
    if (this.isClickedOptionLocked(host, idx, evtOpt)) return null;
    if (host._clickGate) return null;
    host._clickGate = true;
    host.questionFresh.set(false);
    return { idx, q, evtIdx, evtOpt };
  }

  /** Run the synchronous click flow and stash msgTok/lastAllCorrect. Extracted verbatim. */
  private runSyncClickFlow(host: Host, q: QuizQuestion | null, idx: number, evtIdx: number, evtOpt: any, checked: boolean):
    { selOptsSetImmediate: any; isMultiForSelection: boolean; allCorrect: boolean } {
    const clickResult = host.clickOrchestrator.performSynchronousClickFlow({
      question: q!,
      questionIndex: idx,
      evtIdx,
      evtOpt,
      checked,
      optionsToDisplay: host.optionsToDisplay(),
      currentQuestionOptions: host.currentQuestion()?.options,
      totalQuestions: host.totalQuestions(),
      msgTok: host._msgTok
    });
    host._msgTok = clickResult.msgTok;
    host._lastAllCorrect = clickResult.allCorrect;
    return {
      selOptsSetImmediate: clickResult.selectedKeysSet,
      isMultiForSelection: clickResult.isMultiForSelection,
      allCorrect: clickResult.allCorrect,
    };
  }

  /** Lock check: is the clicked option locked for this question? Extracted verbatim. */
  private isClickedOptionLocked(host: Host, idx: number, evtOpt: any): boolean {
    try {
      const lockIdNum = Number(evtOpt?.optionId);
      if (Number.isFinite(lockIdNum) && host.selectedOptionService.isOptionLocked(idx, lockIdNum)) {
        return true;
      }
    } catch (err: unknown) {
      console.error('QqcOrchClickService.handleOptionSelected lock check failed:', err);
    }
    return false;
  }

  /** Microtask: re-apply highlight/feedback/disable unless superseded. Extracted verbatim. */
  private scheduleImmediateClickUpdate(host: Host, idx: number, q: QuizQuestion | null, evtOpt: any, evtIdx: number, selOptsSetImmediate: any): void {
    queueMicrotask(() => {
      if (host._skipNextAsyncUpdates) return;
      host.updateOptionHighlighting(selOptsSetImmediate);
      host.refreshFeedbackFor(evtOpt ?? undefined);
      this.applySingleAnswerDisable(host, idx, q, evtOpt, evtIdx);
      host.cdRef.markForCheck();
    });
  }

  /** setTimeout(0): final single-answer disable pass after the click settles. Extracted verbatim. */
  private scheduleDeferredDisable(host: Host, idx: number, q: QuizQuestion | null, evtOpt: any, evtIdx: number): void {
    setTimeout(() => {
      this.applySingleAnswerDisable(host, idx, q, evtOpt, evtIdx);
      host.sharedOptionComponent?.()?.cdRef?.markForCheck?.();
      host.cdRef?.markForCheck?.();
    }, 0);
  }

  /** Microtask (finally): release the click gate and push the selection message. Extracted verbatim. */
  private scheduleClickGateRelease(host: Host, q: QuizQuestion | null, evtOpt: any): void {
    queueMicrotask(() => {
      host._clickGate = false;
      host.selectionMessageService.releaseBaseline(host.currentQuestionIndex());
      const selectionComplete =
        q?.type === QuestionType.SingleAnswer ? !!evtOpt?.correct : host._lastAllCorrect;
      host.selectionMessageService.setSelectionMessage(selectionComplete);
    });
  }

  /**
   * Single-answer disable: when the clicked option is the (single) correct one,
   * disable every other option and mark wrongly-selected ones incorrect. No-op
   * for multi-answer (incl. pristine-detected multi). Extracted verbatim.
   */
  private applySingleAnswerDisable(host: Host, idx: number, q: QuizQuestion | null, evtOpt: any, evtIdx: number): void {
    try {
      const { isSingleAnswer } = this.computeSingleAnswerDisableContext(host, idx, q);
      if (!isSingleAnswer) return;

      // Lock only once the VERDICT says the question was answered correctly.
      //
      // This used to gate on the clicked option's own `correct` flag and then
      // lock everything outside a correct-id set built from the bank. Neither
      // fact survives the answer key leaving the browser: `evtOpt.correct`
      // would be absent, the guard would never pass, and a correct answer
      // would stop locking anything.
      //
      // Note this path never leaked: it only ran after a CORRECT click, so it
      // disclosed nothing the user had not already earned. What it needed was
      // an authority, not a fix.
      const state = verdictStateForDisplayIndex(host.quizService, idx, this.verdicts);
      if (state?.phase !== 'resolved' || state.isResolvedCorrect !== true) return;

      this.lockAroundCorrectSelection(host, state);
    } catch (err: unknown) {
      console.error('QqcOrchClickService.handleOptionSelected single-answer disable failed:', err);
    }
  }

  /**
   * Derive single-answer disable context: whether this is single-answer (raw
   * flags, with a pristine >1-correct override), whether the clicked option is
   * correct, and the set of correct option keys. Extracted verbatim.
   */
  private computeSingleAnswerDisableContext(host: Host, idx: number, q: QuizQuestion | null):
    { isSingleAnswer: boolean } {
    const rawQuestion: any = host.quizService.getQuestionsInDisplayOrder?.()?.[idx]
      ?? host.quizService?.questions?.[idx]
      ?? q;
    const rawOpts: any[] = rawQuestion?.options ?? [];
    const rawCorrectCount = rawOpts.filter((o: any) => isOptionCorrect(o)).length;

    // The correct-id set that used to be built here is gone. Locking now asks
    // the verdict which option the user got right, so a full answer set never
    // has to exist in the browser for this path to work.
    //
    // What remains is single-vs-multi detection, which is question TYPE rather
    // than correctness. It is still counted from the bank because the local
    // questions carry no declared type; it moves to the type registry with the
    // rest of the type inference, not here.
    // Pristine fallback: stale single-looking raw flags but quizInitialState
    // shows >1 correct => actually multi-answer; skip the single-answer disable.
    const isSingleAnswer = !this.detectPristineMulti(host, rawQuestion) && rawCorrectCount <= 1;
    return { isSingleAnswer };
  }

  /**
   * Lock a correctly-answered single-answer question around the user's pick.
   *
   * "Everything except the correct option" and "everything except the option
   * the user got right" are the same set here — the question is single-answer
   * and resolved correct, so their correct pick IS the answer. Reading it from
   * the verdict's own per-selection result means no correct-id set has to be
   * built, and nothing asks about an option the user never touched.
   *
   * A selected option the verdict marked wrong (an earlier guess still showing)
   * keeps its incorrect marking — that is disclosed by their own selection.
   */
  private lockAroundCorrectSelection(host: Host, state: QuestionVerdictState): void {
    const targets: any[][] = [];
    const soc: any = host.sharedOptionComponent?.();
    if (soc?.optionBindings()?.length) targets.push(soc.optionBindings());
    const sigBindings: any[] = host.optionBindings?.() ?? [];
    if (sigBindings?.length) targets.push(sigBindings);
    for (const arr of targets) {
      for (let bi = 0; bi < arr.length; bi++) {
        const b = arr[bi];
        if (!b) continue;
        const own = selectedVerdictFor(state, b.option?.text);
        const isCorrect = own === true;
        b.disabled = !isCorrect;
        if (b.option) b.option.active = isCorrect;
        if (own === false) {
          b.highlight = true;
          b.showFeedback = true;
          if (b.option) {
            b.option.highlight = true;
            b.option.showIcon = true;
            b.option.feedback = b.option.feedback || 'incorrect';
          }
        }
      }
    }
    soc?.cdRef?.markForCheck?.();
  }

  /**
   * Early multi-answer FET: when all-correct + multi, re-validate against pristine
   * correct texts, then (once per index) stop the timer and trigger the FET.
   * Extracted verbatim.
   */
  private maybeTriggerMultiAnswerFet(host: Host, idx: number, q: QuizQuestion | null, allCorrect: boolean, isMultiForSelection: boolean): void {
    const lockedIndex = host.currentQuestionIndex() ?? idx;

    const fetGatePassed = allCorrect && isMultiForSelection && this.isMultiFullySelected(host, idx, q);

    if (fetGatePassed && !host._fetEarlyShown.has(lockedIndex)) {
      if (host.timerEffect.safeStopTimer('completed', host._timerStoppedForQuestion, host._lastAllCorrect)) {
        host._timerStoppedForQuestion = true;
      }
      host._fetEarlyShown.add(lockedIndex);
      const displayQForFet = host.quizService.getQuestionsInDisplayOrder?.()?.[lockedIndex] ?? q;
      host.explanationFlow.triggerMultiAnswerFet({ lockedIndex, question: displayQForFet }).then((fetResult: any) => {
        if (host.currentQuestionIndex() !== lockedIndex || !fetResult) return;
        host.displayExplanation.set(true);
        host.displayMode.set('explanation');
        host.isAnswered.set(true);
        host.showExplanationChange.emit(true);
        host.explanationToDisplay.set(fetResult.formatted);
        host.explanationToDisplayChange?.emit(fetResult.formatted);
      }).catch(() => {});
    }
  }

  /** RAF-scheduled post-click tasks (feedback, core selection, binding marks). Extracted verbatim. */
  private schedulePostClickRaf(host: Host, idx: number, q: QuizQuestion | null, evtOpt: any, evtIdx: number, event: any): void {
    requestAnimationFrame(() => {
      if (host._skipNextAsyncUpdates || idx !== host.currentQuestionIndex()) return;
      const resolvedQuizId =
        host.quizService.quizId ||
        host.activatedRoute.snapshot.paramMap.get('quizId') ||
        'dependency-injection';
      host.clickOrchestrator.performPostClickRafTasks({
        idx,
        evtOpt: evtOpt ?? undefined,
        evtIdx,
        question: q!,
        event,
        quizId: resolvedQuizId,
        generateFeedbackText: (question: QuizQuestion) => host.generateFeedbackText(question),
        postClickTasks: (opt: any, i: number, checked: boolean, wasPrev: boolean, qIdx: number) =>
          host.postClickTasks(opt, i, checked, wasPrev, qIdx),
        handleCoreSelection: (ev: any, i: number) => this.applyCoreSelection(host, ev, i),
        markBindingSelected: (opt: any) => this.applyMarkBindingSelected(host, opt),
        refreshFeedbackFor: (opt: Option) => host.refreshFeedbackFor(opt),
      }).catch(() => {}).finally(() => {
        this.applySingleAnswerDisable(host, idx, q, evtOpt, evtIdx);
        host.cdRef?.markForCheck?.();
      });
    });
  }

  /** Apply the core selection state result (answered / display mode). Extracted verbatim. */
  private applyCoreSelection(host: Host, ev: any, i: number): void {
    host.performInitialSelectionFlow(ev, ev.option);
    const coreResult = host.optionSelection.handleCoreSelectionState({
      option: ev.option,
      questionIndex: i,
      currentQuestionIndex: host.currentQuestionIndex(),
      questionType: host.question()?.type,
      forceQuestionDisplay: host.forceQuestionDisplay(),
      lastAllCorrect: host._lastAllCorrect,
    });
    if (coreResult.isAnswered) host.isAnswered.set(true);
    host.forceQuestionDisplay.set(coreResult.forceQuestionDisplay);
    if (coreResult.displayStateAnswered) {
      host.isAnswered.set(coreResult.displayStateAnswered);
      host.displayMode.set(coreResult.displayStateMode);
    }
    host.cdRef.markForCheck();
  }

  /** Mark a binding selected and re-emit the bindings signal. Extracted verbatim. */
  private applyMarkBindingSelected(host: Host, opt: any): void {
    const b = host.feedbackManager.markBindingSelected(opt, host.currentQuestionIndex(), host.optionBindings());
    if (!b) return;
    host.optionBindings.set(host.optionBindings().map((ob: any) =>
      ob.option.optionId === b.option.optionId ? b : ob
    ));
    b.directiveInstance?.updateHighlight();
  }

  /** Does quizInitialState show >1 correct option for this question (stale single-flag override)? Extracted verbatim. */
  private detectPristineMulti(host: Host, rawQuestion: any): boolean {
    try {
      const liveQText = norm(rawQuestion?.questionText);
      if (!liveQText) return false;
      const bundleM = host.quizService?.quizInitialState ?? [];
      for (const quizM of bundleM) {
        for (const pqM of (quizM?.questions ?? [])) {
          if (norm(pqM?.questionText) !== liveQText) continue;
          const pristineCorrect = (pqM?.options ?? []).filter((o: any) => isOptionCorrect(o)).length;
          if (pristineCorrect > 1) return true;
          break;
        }
      }
    } catch (err: unknown) { swallow('qqc-orch-click.service.ts pristine multi-answer detect', err); }
    return false;
  }

  /** Are all pristine-correct texts for this multi-answer question selected? (true on error = trust upstream). Extracted verbatim. */
  private isMultiFullySelected(host: Host, idx: number, q: QuizQuestion | null): boolean {
    try {
      const displayQ: any = host.quizService.getQuestionsInDisplayOrder?.()?.[idx]
        ?? host.quizService?.questions?.[idx]
        ?? q;
      let rawCorrectTexts = new Set<string>();
      try {
        rawCorrectTexts = host.quizService.getPristineCorrectTextsForQuestion(displayQ?.questionText);
      } catch (err: unknown) { swallow('qqc-orch-click.service.ts pristine correct-texts read', err); }
      if (rawCorrectTexts.size === 0) {
        const rawOpts: any[] = displayQ?.options ?? [];
        rawCorrectTexts = new Set(
          rawOpts.filter((o: any) => isOptionCorrect(o))
            .map((o: any) => norm(o?.text))
            .filter((t: string) => !!t)
        );
      }
      const svcSel = host.selectedOptionService.getSelectedOptionsForQuestion(idx) ?? [];
      const selTexts = new Set(svcSel.map((s: any) => norm(s?.text)).filter((t: string) => !!t));
      return rawCorrectTexts.size > 0 && [...rawCorrectTexts].every(t => selTexts.has(t));
    } catch {
      return true; // trust upstream
    }
  }
}