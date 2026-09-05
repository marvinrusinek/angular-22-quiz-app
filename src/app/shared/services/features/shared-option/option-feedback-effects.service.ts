import { Service, effect, inject, untracked } from '@angular/core';

import { OptionBindings } from '../../../models/OptionBindings.model';
import { SelectedOption } from '../../../models/SelectedOption.model';

import type { SharedOptionComponent } from '../../../../components/question/answer/shared-option-component/shared-option.component';
import { QuestionVerdictService } from '../verdict/question-verdict.service';
import { norm } from '../../../utils/text-norm';

type Host = SharedOptionComponent;

/**
 * Owns the SharedOptionComponent's two feedback/highlight constructor effects:
 * the multi-answer auto-disable (rebuilds bindings the moment every pristine-
 * correct option is selected) and the timer-expiry watcher (stamps
 * correct/incorrect cssClasses when the timer reports THIS question expired).
 *
 * These are the click-feedback-pipeline-adjacent effects, so the bodies are
 * moved verbatim (`this.` → host-as-any). Both are created here in one method,
 * in their original order, called LAST in the component constructor so overall
 * effect-creation order is preserved. Must run in the host's injection context.
 */
@Service()
export class OptionFeedbackEffectsService {
  private readonly verdicts = inject(QuestionVerdictService);

  // What `repaintOnVerdictArrival` last actually painted, per host. A fresh
  // clone never itself changes `isCorrect` — that field is written elsewhere,
  // in place, by `option-lock-policy.applyAuthorizedCorrectness` — so the only
  // way to know whether a repaint is still owed is to remember what this
  // effect painted last time and compare today's values against THAT, not
  // against the clone it is about to produce (which is always identical to
  // its source by construction).
  private readonly lastRepainted = new WeakMap<Host, string>();

  registerFeedbackEffects(host: Host): void {
    const h = host as any;
    // Four independent effects; bodies extracted to named helpers. The signal
    // reads happen synchronously inside each effect, so dependency tracking is
    // intact (Angular tracks signals read during the effect's execution,
    // including nested calls).
    effect(() => this.applyMultiAnswerAutoDisable(h));
    effect(() => this.applyTimerExpiryStamp(h));
    effect(() => this.repaintOnVerdictArrival(h));
    effect(() => this.stopTimerOnVerdictComplete(h));
  }

  /**
   * Repaint when an AUTHORIZED VERDICT lands.
   *
   * The app is zoneless, and `option-lock-policy.applyAuthorizedCorrectness`
   * writes `b.isCorrect` as a plain field — no signal, so no change detection.
   * The two effects above wake on the SELECTIONS signal, i.e. on a click. The
   * result was that each verdict was painted by the NEXT click's render pass,
   * and the LAST click's verdict had no click behind it: on a three-correct
   * question only two options ever turned green, until something unrelated
   * (switching tabs and back) forced a render.
   *
   * Reading `verdicts.states()` makes verdict arrival itself a dependency.
   * Fresh binding refs are what OnPush option-item children compare, and
   * `getOptionClasses` recomputes `correct-option`/`incorrect-option` from
   * `binding.isCorrect` on the resulting pass.
   *
   * CONVERGENCE. `verdicts.states()` changes identity on every `/check` round
   * trip — the optimistic `checking` write as well as the terminal one — not
   * only on a genuine reveal, so this effect used to re-fire and unconditionally
   * clone+write EVERY current binding on each of those, whether or not
   * anything paintable had actually changed. That re-armed every other effect
   * reading `optionBindings` (e.g. the multi-answer auto-disable effect above)
   * on every firing, which on a completing REVISIT click produced a
   * synchronous run of hundreds of re-entries in tens of milliseconds and
   * froze the tab before the score could ever repaint.
   *
   * The fix compares what is paintable — each option's `isCorrect` — against
   * the fingerprint of what this effect last actually wrote, and only clones
   * and writes when that has genuinely changed.
   */
  private repaintOnVerdictArrival(h: any): void {
    // THE DEPENDENCY. Read first and unconditionally — an early return above
    // this line would silently unsubscribe the effect from verdict arrivals.
    this.verdicts.states();

    // Everything else is untracked: reading optionBindings reactively and then
    // writing it in the same effect would re-trigger this effect forever.
    untracked(() => {
      const bindings: OptionBindings[] = h.optionBindings?.() ?? [];
      if (!bindings.length) return;

      const fingerprint = bindings
        .map((b: OptionBindings) => {
          const text = norm((b as any)?.option?.text ?? '');
          const known = (b as any)?.isCorrect;
          const tri = known === true ? '1' : known === false ? '0' : '?';
          return `${text}:${tri}`;
        })
        .join('|');

      if (this.lastRepainted.get(h) === fingerprint) return;   // nothing paintable changed
      this.lastRepainted.set(h, fingerprint);

      h.optionBindings.set(bindings.map((b: OptionBindings) => ({ ...b })));
      h.cdRef?.markForCheck?.();
    });
  }

  /**
   * Stop the timer the moment the VERDICT says this question is fully,
   * correctly answered — single-answer resolved-correct, or multi-answer with
   * every required correct option selected.
   *
   * REGRESSION (post-Stage-14). The synchronous click-time path
   * (`QqcOptionClickOrchestratorService#computeCorrectness`) derives
   * `allCorrect` from `option.correct` / `isOptionCorrect(option)` — data the
   * API never sends once questions come from `/questions`, so it always read
   * false and the timer never stopped, for single- or multi-answer alike.
   * Nothing else re-checked once the actual `/check` verdict landed.
   *
   * This asks the SAME authority `TimerService#hasRecordedCorrectCompletion`
   * (and therefore `allCorrectSelectedFromVerdict`) already uses for the
   * freeze-on-revisit decision — never local bookkeeping, never `option.correct`.
   * Reading `verdicts.states()` makes verdict arrival itself the trigger, so
   * this fires the instant a terminal verdict lands, however long `/check`
   * took, and stays a no-op for every OTHER question's verdict arrivals.
   */
  private stopTimerOnVerdictComplete(h: any): void {
    // THE DEPENDENCY. Read first and unconditionally — an early return above
    // this line would silently unsubscribe the effect from verdict arrivals.
    this.verdicts.states();

    untracked(() => {
      const qIdx = h.currentQuestionIndex ?? h.quizService?.currentQuestionIndex ?? 0;
      if (!h.timerService?.hasRecordedCorrectCompletion?.(qIdx)) return;

      h.timerService.allowAuthoritativeStop?.();
      h.timerService.attemptStopTimerForQuestion?.({ questionIndex: qIdx });
    });
  }

  /**
   * Multi-answer auto-disable. Reactively watches the selections signal and
   * rebuilds optionBindings with fresh refs the moment every pristine-correct
   * option for THIS rendered question is selected. Pure Angular reactivity —
   * OnPush option-item children pick up new `b` refs via their signal inputs, no DOM,
   * no detectChanges hacks. Identifies the rendered question by option-text
   * fingerprint (against pristine quizInitialState) rather than trusting
   * currentQuestionIndex, which can lag during click flow. Body verbatim.
   */
  private applyMultiAnswerAutoDisable(h: any): void {
    const selectionsMap = h.selectedOptionService.selectedOptionsMapSig();
    if (!h.optionBindings() || h.optionBindings().length === 0) return;

    // AUTHORIZED COMPLETION, THEN THE AUTHORIZED SET (S5-pre).
    //
    // This used to read the pristine correct set twice: once to detect a
    // multi-answer question (`size < 2`) and once to decide the response
    // covered it. Both are now asked of authorities that carry no answer key:
    // the declared type for the cardinality, the verdict for the completion.
    //
    // Order matters. The correct SET is only consulted after completion, and
    // completion is terminal, so the authorized texts exist by the time they
    // are read — nothing here can reveal them earlier.
    const qIdx = h.currentQuestionIndex ?? h.quizService.currentQuestionIndex ?? 0;
    const qText = (h.quizService as any)?.getQuestionsInDisplayOrder?.()?.[qIdx]?.questionText
      ?? (h.quizService as any)?.questions?.[qIdx]?.questionText;

    if (h.quizService.isDeclaredMultiAnswer?.(qText) !== true) return;
    if (!h.quizService.isMultiAnswerComplete?.(qIdx)) return;

    const pristineCorrectTexts: Set<string> =
      h.quizService.getAuthorizedCorrectTextsForQuestion?.(qText) ?? new Set<string>();
    // No authorized set means the reveal has not been released. Disabling on
    // an empty set would grey out every option, so unknown does nothing.
    if (pristineCorrectTexts.size === 0) return;

    // If auto-reveal already stamped _autoRevealedCorrect on the
    // bindings, do not overwrite — auto-reveal's highlight + disable
    // state is authoritative for exhausted-incorrect scenarios.
    if (h.optionBindings().some((b: OptionBindings) => b?._autoRevealedCorrect)) return;

    // Rebuild every binding with fresh refs so OnPush option-items pick
    // up the new disabled state via their signal inputs.
    const correctTexts = pristineCorrectTexts;
    let mutated = false;
    const next = h.optionBindings().map((b: OptionBindings) => {
      const myText = norm(b?.option?.text);
      const isCorrect = correctTexts.has(myText);
      const targetDisabled = !isCorrect;
      if (b.disabled !== targetDisabled) mutated = true;
      return {
        ...b,
        disabled: targetDisabled,
        isCorrect,
        option: b.option ? {
          ...b.option,
          active: isCorrect
        } : b.option
      };
    });
    if (mutated) {
      h.optionBindings.set(next);
      h.cdRef.markForCheck();
    }
  }

  /**
   * Independent timer-expiry watcher: triggers when the timer service
   * authoritatively reports the CURRENT question as expired. Updates bindings
   * via cssClasses so Angular's ngClass paints correctly — no direct DOM
   * manipulation (which bypassed reactive cleanup and left .correct-option
   * leaked on revisited questions).
   *
   * CORRECTNESS SOURCE (S5-pre). This used to derive the reveal from the
   * local bank (`isOptionCorrect` reading `option.correct`) — data that no
   * longer exists once options come from the API, so it silently computed an
   * EMPTY correct set. The sibling subscriber in `shared-option-init.service.ts`
   * already documents the intended replacement: "Timeout correctness now
   * comes from exactly one place: QuestionVerdictService.revealExpiredQuestion()
   * -> correctOptionTexts." This effect now asks the same authority the
   * multi-answer auto-disable effect above uses.
   *
   * That reveal is an async round trip (`QqcOrchTimerService` calls
   * `revealExpiredQuestion()` off the same expiry), so the authorized set may
   * not exist yet the instant the local clock crosses the deadline. Reading
   * `verdicts.states()` makes verdict arrival a tracked dependency, so an
   * empty result at first fire is not final — this effect runs again once the
   * reveal lands. The lock (`disabled`, `timerExpiredForQuestion`) still
   * applies immediately; only the color stamp waits.
   */
  private applyTimerExpiryStamp(h: any): void {
    // Track BOTH signals so the effect re-fires when either changes —
    // but gate on the authoritative expired-index check below.
    const elapsed = h.timerService.elapsedTimeSig();
    const expiredForIdx = h.timerService.expiredForQuestionIndexSig();
    const duration = h.timerService.timePerQuestion;
    const qIdx = h.currentQuestionIndex ?? h.quizService.currentQuestionIndex ?? 0;

    // The authorized set may still be in flight when this first fires — this
    // dependency is what lets the effect re-run once it lands.
    this.verdicts.states();

    // Authoritative gate: only fire when the timer service explicitly
    // marks THIS question as expired. The old `elapsed >= duration`
    // check could fire on stale elapsed reads during Q→Q transitions,
    // stamping the next question's bindings as expired.
    if (expiredForIdx !== qIdx) return;
    if (!(elapsed > 0 && elapsed >= duration)) return;

    // Lock the question the instant the clock says it is over, independent of
    // whether the authorized reveal has arrived yet.
    if (!h._timerExpiryHandled) {
      h._timerExpiryHandled = true;
      h.timerExpiredForQuestion.set(true);
    }

    const question = h.quizService.getQuestionsInDisplayOrder?.()?.[qIdx]
      ?? h.quizService.questions?.[qIdx]
      ?? h.currentQuestion();
    const correctTexts: Set<string> =
      h.quizService.getAuthorizedCorrectTextsForQuestion?.(question?.questionText) ?? new Set<string>();

    // Not authorized yet — wait for the next verdicts.states() change rather
    // than paint from data that no longer exists.
    if (correctTexts.size === 0) return;

    // Idempotent per answer key, not per call: verdicts.states() keeps
    // changing for OTHER questions too, and each of those must not re-stamp
    // this one.
    const paintedKey = [...correctTexts].sort().join('|');
    if (h._timerExpiryPaintedKey === paintedKey) return;
    h._timerExpiryPaintedKey = paintedKey;

    // Stamp bindings via cssClasses + new ref so OnPush option-items
    // re-render. ngClass will apply correct-option/incorrect-option
    // classes through the normal Angular pipeline.
    //
    // `isCorrect` must land on the binding itself, not only in `cssClasses`.
    // `option.service.ts`'s class builder (the one most render paths funnel
    // through) derives `correct-option` from `binding.isCorrect === true`,
    // not from this effect's own `cssClasses` object — every other writer in
    // this file (`applyMultiAnswerAutoDisable` above) already sets it. Without
    // it, that builder's next pass saw the untouched `isCorrect` (still
    // unset) and repainted this option back to uncolored.
    const updated = (h.optionBindings() ?? []).map((b: OptionBindings) => {
      if (!b) return b;
      const optText = norm(b.option?.text);
      const isCorrect = correctTexts.has(optText);
      return {
        ...b,
        isCorrect,
        cssClasses: {
          ...(b.cssClasses || {}),
          'correct-option': isCorrect,
          'incorrect-option': !isCorrect && !!b.isSelected
        },
        _timerExpiredStamped: true,
        _timerExpiredStampedForIndex: qIdx,
        disabled: true
      };
    });
    h.optionBindings.set(updated);
    h.cdRef.markForCheck();
  }
}
