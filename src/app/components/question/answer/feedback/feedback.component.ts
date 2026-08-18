import {
  ChangeDetectionStrategy, Component, effect, inject, input, signal
} from '@angular/core';
import { NgClass } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';

import { FeedbackProps } from '../../../../shared/models/FeedbackProps.model';
import { Option } from '../../../../shared/models/Option.model';
import { QuizQuestion } from '../../../../shared/models/QuizQuestion.model';

import { FeedbackService } from '../../../../shared/services/features/feedback/feedback.service';
import { QuestionVerdictService } from '../../../../shared/services/features/verdict/question-verdict.service';
import { authorizedCorrectTexts, selectedVerdictFor, verdictStateForDisplayIndex } from '../../../../shared/services/features/verdict/authorized-correctness';
import { QuizService } from '../../../../shared/services/data/quiz.service';
import { SelectedOptionService } from '../../../../shared/services/state/selectedoption.service';

import { QUESTION_ROUTE_REGEX } from '../../../../shared/constants/route-patterns';
import { isOptionCorrect } from '../../../../shared/utils/is-option-correct';
import { norm } from '../../../../shared/utils/text-norm';

@Component({
  selector: 'codelab-quiz-feedback',
  standalone: true,
  imports: [NgClass, MatIconModule],
  templateUrl: './feedback.component.html',
  styleUrls: ['./feedback.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class FeedbackComponent {
  // ── injects ─────────────────────────────────────────────────────
  private readonly feedbackService = inject(FeedbackService);
  private readonly quizService = inject(QuizService);
  private readonly questionVerdictService = inject(QuestionVerdictService);
  private readonly selectedOptionService = inject(SelectedOptionService);

  // ── inputs ──────────────────────────────────────────────────────
  readonly feedbackConfig = input<FeedbackProps | null | undefined>(undefined);
  readonly stylePreset = input<'default' | 'inline'>('default');

  // ── remaining variables ─────────────────────────────────────────
  readonly feedbackMessageClass = signal('');
  readonly displayMessage = signal('');

  constructor() {
    // Re-runs whenever the feedbackConfig signal input changes (replaces
    // the prior ngOnInit + ngOnChanges pair). Truthy-only gate matches the
    // old `'feedbackConfig' in changes && !!currentValue` check; an
    // initial undefined value is just ignored until the parent provides one.
    effect(() => {
      const cfg = this.feedbackConfig();
      // Reactive dependency: re-run when this question's UI selections change
      // (e.g. COMPLETING a multi-answer on REVISIT, where the parent doesn't push
      // a fresh feedbackConfig) so the win message can replace "select N more".
      this.selectedOptionService.uiSelectedTextsSig();

      // Reactive dependency: RECOMPUTE WHEN THE VERDICT ARRIVES.
      //
      // Correctness comes from `/check`, which is still in flight at click
      // time, so the first pass has nothing authorized to describe and renders
      // nothing. Without this read the blank would simply persist — the same
      // click-vs-authorization gap the FET had to close.
      //
      // A signal read rather than a subscription: it re-runs only while this
      // component is alive, is torn down with it, and always recomputes from
      // the CURRENT `feedbackConfig`, so a verdict landing after navigation
      // cannot write question A's feedback onto question B.
      this.questionVerdictService.states();

      if (cfg) this.updateFeedback();
    });
  }

  private updateFeedback(): void {
    if (this.feedbackConfig()?.showFeedback) {
      this.updateDisplayMessage();
      this.feedbackMessageClass.set(this.determineFeedbackMessageClass());
    } else {
      this.displayMessage.set('');
    }
  }


  /**
   * Was the user's own pick correct, per the AUTHORIZED verdict?
   *
   * The template chose its icon from `selectedOption.correct`, which
   * API-sourced options do not carry — so a correct answer showed the sad face
   * beside a message reading "You're right!". Same rule as the message class.
   */
  readonly isSelectedOptionCorrect = (): boolean =>
    this.determineFeedbackMessageClass() === 'correct-message';

  private determineFeedbackMessageClass(): string {
    // AUTHORIZED FIRST. This read `selectedOption.correct`, which API-sourced
    // options do not carry — so a correct answer was styled (and iconed) as
    // wrong even while the message itself said "You're right!".
    //
    // `selectedVerdictFor` answers only for an option the user actually
    // submitted, and only once checked; `undefined` means not yet known, and
    // the neutral class is the honest state for that moment.
    const selected = this.feedbackConfig()?.selectedOption;
    const state = verdictStateForDisplayIndex(
      this.quizService,
      this.quizService.currentQuestionIndex ?? 0,
      this.questionVerdictService
    );
    const authorized = selectedVerdictFor(state, selected?.text);

    if (authorized === true) return 'correct-message';
    if (authorized === false) return 'wrong-message';

    // A CHECK IN FLIGHT IS NOT A VERDICT.
    //
    // While `/check` is outstanding the answer is genuinely unknown, so the
    // fallback below must not speak for it. It used to: a correct click painted
    // the box RED for the length of the round trip and then flipped to green
    // when the verdict landed — visible as a red-to-green flash, and on a slow
    // connection long enough to read as "wrong" before correcting itself.
    //
    // The flash came from the fallback reading a `correct: false` that no
    // server ever sent (some construction paths still materialize that flag
    // from absent correctness). Neutral is the honest state for this moment
    // either way, and it costs nothing: the verdict arrives and repaints.
    if (state?.phase === 'checking') return '';

    // Nothing authorized yet — fall back to the local flag only while it still
    // exists (bank-sourced quizzes); absent, stay neutral rather than claim
    // wrong.
    if (selected?.correct === true) return 'correct-message';
    if (selected?.correct === false) return 'wrong-message';
    return '';
  }

  private updateDisplayMessage(): void {
    // Cache the signal value once — re-reading risks a different value mid-method.
    const cfg = this.feedbackConfig();
    if (!cfg) {
      this.displayMessage.set('');
      return;
    }

    // Prefer the parent-computed feedback, but only if its cached "Option N"
    // still matches the live URL question (see cachedFeedbackMatchesUrl).
    const cachedFeedback = cfg.feedback?.trim();
    if (cachedFeedback) {
      // A cached "That's correct! Please select N more correct answer(s)." goes
      // stale the moment the user COMPLETES the question (notably on REVISIT,
      // where the parent doesn't recompute it). When every correct option is now
      // selected, skip the cache and regenerate so the win message shows.
      const isPartialProgress = /please select\b.*\bmore correct answers?\b/i.test(cachedFeedback);
      const staleOnCompletion = isPartialProgress && this.allCorrectSelectedForCurrentQuestion();
      if (!staleOnCompletion && this.cachedFeedbackMatchesUrl(cfg, cachedFeedback) && cfg.feedback) {
        this.displayMessage.set(cfg.feedback);
        return;
      }
    }

    const msg = this.regenerateFeedbackMessage(cfg);
    if (msg && msg.trim()) {
      this.displayMessage.set(msg);
      return;
    }

    this.displayMessage.set('');
  }

  // Prioritize the parent-computed message ONLY if the cached "Option N" matches
  // the live URL question's correct option — otherwise a Q1 string ("The correct
  // answer is Option 1.") would display verbatim on Q3 after navigation.
  private cachedFeedbackMatchesUrl(cfg: FeedbackProps, cachedFeedback: string): boolean {
    let cacheMatchesUrl = true;
    try {
      const m = window.location.pathname.match(QUESTION_ROUTE_REGEX);
      if (m) {
        const urlIdx = Number(m[1]) - 1;
        const liveQ = this.quizService.questions?.[urlIdx];
        const correctIdxs: number[] = (liveQ?.options ?? [])
          .map((o: Option, i: number) => o?.correct ? i + 1 : null)
          .filter((n: number | null): n is number => n !== null);
        // If the cached string says "Option N" but the live question's
        // actual correct option isn't N, fall through and regenerate.
        const optionMatch = cachedFeedback.match(/Option\s+(\d+)/i);
        if (optionMatch && correctIdxs.length > 0) {
          const cachedOptN = Number(optionMatch[1]);
          cacheMatchesUrl = correctIdxs.includes(cachedOptN);
        }

        // ALSO reject a cached "Not this one, try again!" when the user
        // actually clicked an option whose text matches a correct option
        // in the live URL question. Single-answer questions on the last
        // index were cementing the negative message because the upstream
        // click handler couldn't see the canonical correct flag.
        if (cacheMatchesUrl && /not this one/i.test(cachedFeedback) &&
            this.clickedTextMatchesCorrectOption(cfg, urlIdx, liveQ)) {
          cacheMatchesUrl = false;
        }
      }
    } catch {}
    return cacheMatchesUrl;
  }

  // True when EVERY correct option of the live URL (multi-answer) question is
  // currently selected and no incorrect option is — i.e. the question is
  // complete. Reads uiSelectedTextsSig (live bindings ∪ first-visit snapshot),
  // which survives navigation, so it holds even when the question is completed
  // on a REVISIT. Used to reject a stale "select N more" cached message.
  private allCorrectSelectedForCurrentQuestion(): boolean {
    try {
      const m = window.location.pathname.match(QUESTION_ROUTE_REGEX);
      if (!m) return false;
      const urlIdx = Number(m[1]) - 1;
      const liveQ =
        this.quizService.getDisplayedQuestion?.(urlIdx) ??
        this.quizService.questions?.[urlIdx];
      const opts: Option[] = liveQ?.options ?? [];
      if (!opts.length) return false;

      // AUTHORIZED FIRST. The correct set was built from `isOptionCorrect`,
      // which is empty for API-sourced options — so completion never registered
      // and a stale "select N more" message survived the completing click on a
      // REVISIT, hiding the win.
      const authorized = authorizedCorrectTexts(
        this.quizService, urlIdx, this.questionVerdictService
      );

      const correctTexts = new Set<string>(authorized ?? []);
      const allTexts = new Set<string>();
      for (const o of opts) {
        const t = norm(o?.text);
        if (t) allTexts.add(t);
        if (!authorized && isOptionCorrect(o) && t) correctTexts.add(t);
      }
      if (correctTexts.size <= 1) return false;  // multi-answer only

      const ui = this.selectedOptionService.uiSelectedTextsForQuestion(urlIdx);
      let correct = 0;
      let incorrect = 0;
      for (const t of ui) {
        if (correctTexts.has(t)) correct++;
        else if (allTexts.has(t)) incorrect++;
      }
      return correct >= correctTexts.size && incorrect === 0;
    } catch {
      return false;
    }
  }

  // True when the user's clicked option text matches a correct option in the
  // live URL question — used to reject a stale "Not this one" cached message.
  private clickedTextMatchesCorrectOption(
    cfg: FeedbackProps,
    urlIdx: number,
    liveQ: QuizQuestion | undefined
  ): boolean {
    const candidates: string[] = [];
    const sel: any = cfg.selectedOption;
    if (sel?.text) candidates.push(norm(sel.text));

    // Also look at the selectedOptionService — it carries the
    // authoritative committed click for this question, which can
    // be more current than feedbackConfig.selectedOption when the
    // upstream click handler hasn't refreshed the config yet.
    try {
      const liveSelections =
        this.selectedOptionService?.getSelectedOptionsForQuestion?.(urlIdx) ?? [];
      for (const s of liveSelections) {
        if (s?.text) candidates.push(norm(s.text));
      }
    } catch { /* ignore */ }

    if (candidates.length && Array.isArray(liveQ?.options)) {
      for (const candidateText of candidates) {
        const match = liveQ.options.find(
          (o: Option) => norm(o?.text) === candidateText
        );
        if (isOptionCorrect(match)) return true;
      }
    }
    return false;
  }

  private regenerateFeedbackMessage(cfg: FeedbackProps): string {
    const fallbackIndex = Number.isFinite(cfg.idx) ? cfg.idx : 0;
    const selectedQuestionIndex = Number.isFinite(
      (cfg.selectedOption as { questionIndex?: number } | null)?.questionIndex
    )
      ? ((cfg.selectedOption as { questionIndex?: number }).questionIndex as number)
      : undefined;
    const activeQuestionIndex = Number.isFinite(
      this.quizService.currentQuestionIndex
    )
      ? (this.quizService.currentQuestionIndex as number)
      : undefined;
    const idx =
      cfg.questionIndex ?? selectedQuestionIndex ?? activeQuestionIndex ?? fallbackIndex;

    const question =
      cfg.question ??
      this.quizService.questions?.[idx] ??
      (cfg.options
        ? {
          questionText: '',
          options: cfg.options,
          explanation: '',
          type: undefined
        }
        : null);

    // MULTI-ANSWER: use ALL selections for this question
    const selectedFromMap =
      this.selectedOptionService.getSelectedOptionsForQuestion(idx) ?? [];
    const fallbackSelected = cfg.selectedOption
      ? [
        {
          ...cfg.selectedOption,
          selected: true,
          questionIndex: idx
        }
      ]
      : [];
    const selected =
      selectedFromMap.length > 0 ? selectedFromMap : fallbackSelected;

    return question
      ? this.feedbackService.buildFeedbackMessage(
        question,
        selected,
        false,
        cfg.timedOut === true,
        idx
      )
      : '';
  }
}