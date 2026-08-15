import { Service, effect } from '@angular/core';

import { OptionBindings } from '../../../models/OptionBindings.model';

import type { SharedOptionComponent } from '../../../../components/question/answer/shared-option-component/shared-option.component';

type Host = SharedOptionComponent;

/**
 * Owns the SharedOptionComponent's question-transition (Q→Q) cleanup effect:
 * on an actual question-index change it strips leftover timer-expiry stamps,
 * selection/feedback/highlight state and the radio-group form value so the
 * incoming question renders clean (Angular reuses .option-row DOM nodes across
 * the @for rebuild, so per-binding flags and cssClasses otherwise persist).
 *
 * The effect must be created in the host's injection context, so this is called
 * synchronously from the component constructor — at the original position,
 * between the two UI-sync registrations, preserving creation order. The body is
 * moved verbatim; `this.` host access becomes `h.` (host-as-any), matching the
 * component's documented "services mutate these fields via host as any" pattern.
 */
@Service()
export class OptionInteractionEffectsService {
  // Per-host last-seen question index that gates the transition cleanup. A
  // WeakMap (not a single field) because this service is a root singleton, but
  // the closure variable it replaces was per-component-instance.
  private readonly lastQIdxByHost = new WeakMap<Host, number>();

  registerQuestionTransitionCleanup(host: Host): void {
    const h = host as any;
    effect(() => {
      const v = host.currentQuestionIndexInput();
      if (v !== undefined) {
        // Q→Q transition cleanup — only on an ACTUAL index change. Strip
        // leftover timer-expiry stamps and selection/feedback/highlight state
        // so the incoming question renders clean (Angular reuses .option-row
        // DOM nodes across the @for rebuild, so per-binding flags and
        // cssClasses otherwise persist). Two phases: an immediate reset and a
        // deferred (microtask) scrub gated on whether the question is resolved.
        const lastQIdx = this.lastQIdxByHost.get(host);
        if (lastQIdx !== undefined && lastQIdx !== v) {
          this.resetBindingsAndState(h, v);
          this.scheduleScrubIfUnresolved(h, v);
        }
        this.lastQIdxByHost.set(host, v);
        h.currentQuestionIndex = v;
      }
    });
  }

  /**
   * Immediate transition reset: clear timer-expiry flags, reset every binding
   * (and its option) in place, and wipe the per-question selection/feedback/
   * highlight maps plus the radio-group form value. Body verbatim from the
   * inline effect.
   */
  private resetBindingsAndState(h: any, v: number): void {
    h.timerExpiredForQuestion.set(false);
    h._timerExpiryHandled = false;
    for (const b of h.optionBindings() ?? []) {
      if (!b) continue;
      delete b._timerExpiredStamped;
      delete b._timerExpiredStampedForIndex;
      delete b._autoRevealedCorrect;
      delete b._autoRevealLocked;
      if (b.cssClasses) {
        delete b.cssClasses['correct-option'];
        delete b.cssClasses['incorrect-option'];
      }
      b.isSelected = false;
      b.disabled = false;
      b.highlight = false;
      b.showFeedback = false;
      b.highlightCorrect = false;
      b.highlightIncorrect = false;
      if (b.option) {
        b.option.selected = false;
        b.option.highlight = false;
        b.option.showIcon = false;
        b.option.active = true;
        delete b.option._autoRevealedCorrect;
        delete b.option.feedback;
      }
    }
    h.selectedOptionMap.clear();
    h.perQuestionHistory.clear();
    // Clear durable per-question click history for the INCOMING
    // question so a 2nd visit doesn't see "all incorrects already
    // clicked" and trigger autoreveal on the very first new click.
    h._multiSelectByQuestion?.delete(v);
    // Clear the durable disabled set for the INCOMING question — disabling must
    // not persist across navigation. Without this, a wrong option locked on the
    // first visit (added to disabledOptionsPerQuestion) re-applies on binding
    // regeneration and the option renders disabled-but-unhighlighted on revisit,
    // so it can't be re-clicked. (b.disabled is reset above, but the durable map
    // re-applies it.)
    h.disabledOptionsPerQuestion?.delete(v);
    h.selectedOptionHistory = [];
    h.lastFeedbackOptionId = -1;
    h.lastFeedbackQuestionIndex = v;
    h.feedbackConfigs = {};
    h.showFeedbackForOption = {};
    h.showFeedback.set(false);
    h.highlightedOptionIds.clear();
    h.flashDisabledSet.clear();
    h.lockedIncorrectOptionIds.clear();
    h.forceDisableAll.set(false);
    h._feedbackDisplay = null;
    h._lastClickFeedback = null;
    h.activeFeedbackConfig.set(null);
    // Reset the radio-group form value so Q3's index-3 click ("All of
    // the above") doesn't carry over and auto-check Q5's NgModule
    // (also at displayIndex 3). The pre-checked state suppresses
    // mat-radio-button's (change) event on subsequent clicks.
    try {
      h.form?.get('selectedOptionId')?.setValue(null, { emitEvent: false });
    } catch { /* ignore */ }
  }

  /**
   * Deferred scrub: if the incoming question is NOT already resolved
   * (scored-correct / locked / multi-perfect / confirmed-correct), queue a
   * microtask that re-scrubs the bindings and replaces each with a fresh
   * spread so OnPush option-items re-render clean. Gated this way so the click
   * pipeline's own signal writes don't get scrubbed back to false on a resolved
   * question. Body verbatim from the inline effect.
   */
  private scheduleScrubIfUnresolved(h: any, v: number): void {
    const _res = h.questionResolution.resolveQuestionState(v, { includeSelections: false });
    const _confirmedCorrect = h.selectedOptionService.clickConfirmedDotStatus?.get(v) === 'correct';
    const _isResolved =
      (_res.scoredCorrect && (!_res.isCanonMulti || _res.multiPerfect)) ||
      h.selectedOptionService.isQuestionLocked?.(v) === true ||
      _res.multiPerfect ||
      (!_res.isCanonMulti && _confirmedCorrect);
    if (!_isResolved) {
      queueMicrotask(() => {
        h._multiSelectByQuestion?.delete(v);
        const current = h.optionBindings() ?? [];
        for (const b of current) {
          if (!b) continue;
          delete b._timerExpiredStamped;
          delete b._timerExpiredStampedForIndex;
          delete b._autoRevealedCorrect;
          delete b._autoRevealLocked;
          // Also clear binding-level cssClasses that drive
          // ngClass — without this the `correct-option` / `selected`
          // classes persist via DOM reuse + OnPush staleness.
          if (b.cssClasses) {
            delete b.cssClasses['correct-option'];
            delete b.cssClasses['incorrect-option'];
          }
          b.isSelected = false;
          if (b.option) {
            delete b.option._autoRevealedCorrect;
            // Reset option-level state that persists on shared refs
            // across navigations — without this, prior-visit clicks
            // make preserveOptionHighlighting re-render them as
            // highlighted on revisit.
            b.option.selected = false;
            b.option.highlight = false;
            b.option.showIcon = false;
          }
        }
        // Replace EACH binding object with a fresh spread (not just
        // the array reference) so OnPush option-items see their
        // individual input ref change and re-render. Without this,
        // in-place mutations are invisible to change detection and
        // leftover inline styles + cssClasses persist on DOM-reused
        // elements (mat-checkbox keeps mat-mdc-checkbox-checked, etc.).
        h.optionBindings.set(current.map((b: OptionBindings) => b ? { ...b } : b));
        h.cdRef.markForCheck();
      });
    }
  }
}
