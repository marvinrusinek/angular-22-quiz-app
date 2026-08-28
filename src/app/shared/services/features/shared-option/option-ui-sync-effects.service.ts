import { Service, effect, untracked } from '@angular/core';

import { Option } from '../../../models/Option.model';

import type { SharedOptionComponent } from '../../../../components/question/answer/shared-option-component/shared-option.component';
import { norm } from '../../../utils/text-norm';

type Host = SharedOptionComponent;

/**
 * Owns the SharedOptionComponent's UI-sync constructor effects: the signal
 * input → backing-field mirrors plus the render-sync watchdogs (auto-show
 * options, self-heal binding generation). These are split across two register
 * methods so the host can preserve the EXACT original effect-creation order
 * around the interaction (Q→Q cleanup) effect that sits between them — creation
 * order is load-bearing because effects flush in creation order when several
 * inputs change in the same tick.
 *
 * Each effect must be created in the host's injection context, so these methods
 * are called synchronously from the component constructor (which IS an
 * injection context); they close over `host` to reach its signals/fields.
 */
@Service()
export class OptionUiSyncEffectsService {
  /**
   * Effect #1 (original position): mirror the currentQuestion signal input into
   * the mutable backing field. Registered before the interaction cleanup effect.
   */
  registerCurrentQuestionMirror(host: Host): void {
    effect(() => this.applyCurrentQuestionMirror(host));
  }

  /**
   * Effects #3–#9 (original positions): the remaining input mirrors
   * (optionsToDisplay + shuffle guard, type, optionBindings + auto-reveal
   * guard, isNavigatingBackwards, renderReady) and the render-sync watchdogs
   * (auto-show options, self-heal binding generation). Dispatcher only — each
   * effect's body is a named helper below; signal reads happen synchronously
   * inside the effect, so dependency tracking is intact. Order preserved.
   */
  registerInputAndRenderSync(host: Host): void {
    effect(() => this.applyOptionsToDisplaySync(host));
    effect(() => this.applyTypeMirror(host));
    effect(() => this.applyOptionBindingsSync(host));
    effect(() => this.applyAutoShowOptions(host));
    effect(() => this.applySelfHealBindings(host));
    effect(() => this.applyNavigatingBackwardsMirror(host));
    effect(() => this.applyRenderReadyMirror(host));
  }

  // ── effect bodies (verbatim from the original inline effects) ────

  /** Mirror the currentQuestion signal input into the mutable backing field. */
  private applyCurrentQuestionMirror(host: Host): void {
    const v = host.currentQuestionInput();
    if (v !== undefined) host.currentQuestion.set(v);
  }

  /**
   * Mirror optionsToDisplay, with a SHUFFLE GUARD: if the incoming options'
   * text set doesn't match the shuffled question's options for this index,
   * replace them with the correct shuffled options.
   */
  private applyOptionsToDisplaySync(host: Host): void {
    let v = host.optionsToDisplayInput();
    if (v !== undefined) {
      const qs = host.quizService;
      if (qs.isShuffleEnabled() && qs.shuffledQuestions?.length > 0) {
        const idx = host.currentQuestionIndex ?? qs.currentQuestionIndex ?? 0;
        const correctQ = qs.shuffledQuestions[idx];
        if (correctQ?.options?.length > 0 && v.length > 0) {
          const correctTexts = new Set(correctQ.options.map((o: Option) => norm(o?.text)));
          const actualTexts = new Set(v.map((o: Option) => norm(o?.text)));
          const match = correctTexts.size === actualTexts.size && [...correctTexts].every(t => actualTexts.has(t));
          if (!match) {
            v = correctQ.options.map((o: Option) => ({ ...o }));
          }
        }
      }
      host.optionsToDisplay = v;
    }
  }

  /** Mirror the type signal input into the mutable backing field. */
  private applyTypeMirror(host: Host): void {
    const v = host.typeInput();
    if (v !== undefined) host.type = v;
  }

  /**
   * Mirror optionBindings, but don't let a stale parent push overwrite
   * auto-reveal bindings: the parent's optionBindings() doesn't carry
   * _autoRevealedCorrect, so a zone.js tick re-evaluating the parent template
   * would wipe the green highlight set by triggerAllIncorrectsExhaustedAutoReveal.
   * The same is true of a timer-expiry reveal — the parent's pushed array
   * doesn't carry _timerExpiredStamped either, so a push landing right after
   * the timeout coloring is applied would erase it the same way. Both are
   * terminal, authoritative reveals; neither is something a routine parent
   * re-render is entitled to undo.
   *
   * CONVERGENCE. The guard used to read `host.optionBindings()` as a plain
   * tracked call, which made this effect's own target a dependency of itself:
   * every write elsewhere to `optionBindings` (the multi-answer auto-disable
   * effect's disabled/isCorrect stamps, the verdict-arrival repaint) re-fired
   * THIS effect, which then unconditionally overwrote those stamps with the
   * stale parent-pushed array — undoing the other effect's work and making
   * it re-fire and re-stamp, which re-fired this one again. That two-file
   * ping-pong, not any single effect failing to converge on its own, was the
   * remaining freeze after the verdict-arrival repaint was fixed to compare
   * before writing.
   *
   * Fixing the ping-pong made this effect settle in one pass instead of many
   * — which also meant it could now deterministically WIN the race against a
   * timer-expiry stamp arriving moments earlier, on the one field the guard
   * did not yet know to protect. The endless retries used to occasionally
   * let the stamp survive by chance; converging removed that chance along
   * with the storm, so the guard has to name what it protects explicitly.
   *
   * The only genuine trigger for this effect is a real parent push —
   * `optionBindingsInput()` changing. Reading the current bindings only to
   * check for a protected reveal must not itself keep this effect subscribed
   * to every write anyone else makes to the same signal.
   */
  private applyOptionBindingsSync(host: Host): void {
    const v = host.optionBindingsInput();
    if (v !== undefined) {
      const hasProtectedReveal = untracked(() =>
        host.optionBindings().some((b) => b?._autoRevealedCorrect || b?._timerExpiredStamped)
      );
      if (hasProtectedReveal) return;
      host.optionBindings.set(v);
    }
  }

  /**
   * Auto-show options when bindings are populated. Without this, paths that
   * populate optionBindings without calling showOptions.set(true) (e.g. dynamic
   * component creation) leave the template gated and options never render.
   */
  private applyAutoShowOptions(host: Host): void {
    if (host.optionBindings().length > 0) host.showOptions.set(true);
  }

  /**
   * SELF-HEAL WATCHDOG: when optionsToDisplay has items but optionBindings is
   * empty, the binding generation race lost — options never render. Force
   * generation. Runs only while the mismatch persists (no infinite loop —
   * once bindings exist the condition stops firing).
   */
  private applySelfHealBindings(host: Host): void {
    const opts = host.optionsToDisplay;
    const bindings = host.optionBindings();
    if (Array.isArray(opts) && opts.length > 0 && (!bindings || bindings.length === 0)) {
      // Reset the early-return guard in generateOptionBindings
      host.optionBindingsInitialized.set(false);
      // Defer one microtask so we don't recurse inside the current effect
      queueMicrotask(() => {
        try {
          host.generateOptionBindings();
        } catch (err: unknown) {
          console.error('SharedOptionComponent self-heal generateOptionBindings failed', err);
        }
      });
    }
  }

  /** Mirror the isNavigatingBackwards signal input. */
  private applyNavigatingBackwardsMirror(host: Host): void {
    host.isNavigatingBackwards.set(host.isNavigatingBackwardsInput());
  }

  /** Mirror the renderReady signal input. */
  private applyRenderReadyMirror(host: Host): void {
    host.renderReady.set(host.renderReadyInput());
  }
}
