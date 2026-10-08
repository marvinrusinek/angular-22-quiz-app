import { Service, inject, signal } from '@angular/core';

import { buildHeadingInputs, HeadingInputDeps } from '@shared/utils/heading-inputs';
import { HeadingInputs, shouldShowFet } from '@shared/utils/heading-model';
import { composeAnswerAnnouncement, htmlToAnnouncementText } from '@shared/utils/compose-answer-announcement';

import { ExplanationTextService } from '@shared/services/features/explanation/explanation-text.service';
import { FeedbackPolicyService } from '@shared/services/features/interview/feedback-policy.service';
import { QuestionVerdictService } from '@shared/services/features/verdict/question-verdict.service';
import { QuizNavigationService } from '@shared/services/flow/quiz-navigation.service';
import { QuizQuestionManagerService } from '@shared/services/flow/quizquestionmgr.service';
import { QuizService } from '@shared/services/data/quiz.service';
import { QuizStateService } from '@shared/services/state/quizstate.service';
import { SelectedOptionService } from '@shared/services/state/selectedoption.service';
import { SelectionMessageService } from '@shared/services/features/selection-message/selection-message.service';
import { TimerService } from '@shared/services/features/timer/timer.service';
import { TopicQuizTypeRegistry } from '@shared/services/api/topic-quiz-type-registry.service';

/**
 * Composes AND HOLDS the ONE coordinated announcement for Topic Quiz's
 * persistent, visually-hidden announcer — see compose-answer-announcement.ts
 * for the answer-outcome rules, and composeQuestionArrivalAnnouncement's own
 * comment for the navigation-arrival rule.
 *
 * The announcer's text lives HERE (a root singleton `@Service()`) rather
 * than on SharedOptionComponent, which is where it used to live. Why: the
 * NAVIGATION announcement must be written from QuizComponent, several
 * component-template boundaries above the actual `<app-shared-option>`
 * instance (QuizComponent -> ... -> AnswerComponent -> SharedOptionComponent
 * — confirmed by grepping every template for its selector). A `viewChild`
 * query only searches the QUERYING component's OWN template view, never
 * descending into a child component's internally-defined template, so
 * `viewChild(SharedOptionComponent)` in QuizComponent can never resolve
 * (confirmed live: it is always undefined, even though the SAME-shaped
 * `viewChild('qText')` query for a template-local ref works fine one line
 * away). A root service both components already inject sidesteps the tree
 * entirely — this is what singleton services are for.
 *
 * Reuses the SAME pure decision the question/FET heading already makes
 * (`buildHeadingInputs` + `shouldShowFet`, from heading-inputs.ts /
 * heading-model.ts) so "is the explanation due right now" is answered
 * identically in both places — this service does not re-derive or
 * second-guess that logic, only reads its result, so the heading's own
 * (separately proven) correctness rules cannot drift from what gets spoken.
 */
@Service()
export class AnswerAnnouncementCoordinatorService {
  /**
   * Text for the single, persistent, visually-hidden announcer — bound
   * directly in shared-option.component.html. Carries exactly ONE of two
   * mutually-exclusive composed messages at a time, written through the
   * shared `writeAnnouncement` below:
   *   - an answer OUTCOME (feedback alone; feedback + "select N more"; or
   *     feedback + explanation), via `announceOutcome`, called from
   *     SharedOptionComponent.onFeedbackAnnounced; or
   *   - a NAVIGATION arrival (the new question's own text), via
   *     `announceQuestionArrival`, called from QuizComponent's route-focus
   *     effect on every actual question-index change.
   */
  readonly announcedFeedback = signal('');

  /**
   * Monotonic token guarding the deferred restore write in
   * `writeAnnouncement` below against a newer click, a newer navigation, or
   * a Q→Q clear, superseding it before its timer fires. Belt-and-suspenders
   * alongside `pendingAnnouncerTimeoutId` (the real cancellation mechanism)
   * — this also protects against the timer having already fired into the
   * macrotask queue before a cancel runs.
   */
  private announcementGeneration = 0;

  /** The pending restore timer from `writeAnnouncement` below, or null. */
  private pendingAnnouncerTimeoutId: ReturnType<typeof setTimeout> | null = null;

  private readonly quizService = inject(QuizService);
  private readonly explanationTextService = inject(ExplanationTextService);
  private readonly timerService = inject(TimerService);
  private readonly selectedOptionService = inject(SelectedOptionService);
  private readonly quizStateService = inject(QuizStateService);
  private readonly quizNavigationService = inject(QuizNavigationService);
  private readonly quizQuestionManagerService = inject(QuizQuestionManagerService);
  private readonly feedbackPolicyService = inject(FeedbackPolicyService);
  private readonly questionVerdictService = inject(QuestionVerdictService);
  private readonly topicQuizTypeRegistry = inject(TopicQuizTypeRegistry);
  private readonly selectionMessageService = inject(SelectionMessageService);

  /** Shared gatherer — see heading-inputs.ts; both methods below read the
   *  SAME live state the question/FET heading itself decides from, for the
   *  CURRENT question index, at call time. */
  private gatherHeadingInputs(): HeadingInputs | null {
    const idx = this.quizService.currentQuestionIndex ?? 0;
    const deps: HeadingInputDeps = {
      idx,
      quizService: this.quizService,
      explanationTextService: this.explanationTextService,
      timerService: this.timerService,
      selectedOptionService: this.selectedOptionService,
      quizStateService: this.quizStateService,
      quizNavigationService: this.quizNavigationService,
      quizQuestionManagerService: this.quizQuestionManagerService,
      feedbackPolicyService: this.feedbackPolicyService,
      questionVerdictService: this.questionVerdictService,
      topicQuizTypeRegistry: this.topicQuizTypeRegistry,
    };
    return buildHeadingInputs(deps);
  }

  /**
   * `feedbackText`/`isCorrect` describe THIS click's own verdict (from
   * FeedbackComponent, which already derives both correctly — see its
   * `determineFeedbackMessageClass`). Everything else needed to classify
   * the event (is the explanation due right now? what does the CURRENT
   * selection-message guidance say?) is read fresh, for the CURRENT
   * question index, at call time.
   */
  private compose(feedbackText: string, isCorrect: boolean): string {
    const inputs = this.gatherHeadingInputs();
    const fetDue = !!inputs && shouldShowFet(inputs);
    const fetText = fetDue ? inputs!.fetHtml : '';
    const progressGuidance = this.selectionMessageService.getCurrentMessage();

    return composeAnswerAnnouncement({
      feedbackText,
      isCorrect,
      fetDue,
      fetText,
      progressGuidance,
    });
  }

  /**
   * The current question's own text (with its multi-answer banner when
   * applicable) for a NAVIGATION-arrival announcement.
   *
   * Deliberately NEVER the FET: on a genuine revisit the heading itself
   * already shows the question text, not the explanation (shouldShowFet's
   * own revisit guard) — mirroring that here keeps this announcement
   * consistent with what is actually shown for the common case, and stays
   * narrowly scoped to the navigation-speech problem rather than also
   * deciding when an explanation may be disclosed (that remains
   * shouldShowFet/deriveHeadingHtml's job alone).
   */
  private composeQuestionArrivalAnnouncement(): string {
    const inputs = this.gatherHeadingInputs();
    if (!inputs) return '';
    return htmlToAnnouncementText(inputs.questionHtml);
  }

  /** Called from SharedOptionComponent.onFeedbackAnnounced. */
  announceOutcome(feedbackText: string, isCorrect: boolean): void {
    this.writeAnnouncement(this.compose(feedbackText, isCorrect));
  }

  /**
   * Called from QuizComponent's route-focus effect on every actual
   * question-index change (initial arrival AND every Next/Previous).
   *
   * Why this exists: a real Narrator retest found that moving focus to the
   * question heading alone does not reliably interrupt speech Narrator had
   * already queued from the page/question just left. This writes the
   * current question's own text through the SAME mechanism already
   * field-verified to reliably reach Narrator for answer feedback, rather
   * than inventing an untested second channel. This is a CANDIDATE
   * mitigation, not a confirmed fix — only a real Narrator retest proves
   * whether it actually interrupts the previous speech.
   */
  announceQuestionArrival(): void {
    this.writeAnnouncement(this.composeQuestionArrivalAnnouncement());
  }

  /**
   * Shared clear-then-restore write used by both `announceOutcome` and
   * `announceQuestionArrival` — exactly one of the two is ever in flight at
   * a time (a click outcome or a navigation arrival), so one pending-timer
   * slot is sufficient.
   *
   * Clears to '' immediately, then restores `text` after a REAL 100ms
   * delay (setTimeout, a macrotask — not queueMicrotask). This is not a
   * stagger against competing live regions (there are none left to compete
   * with — see the removed heading/selection-message aria-live, documented
   * on their own templates); it exists for a different, proven reason:
   * live Narrator testing showed a clear-then-set on the SAME
   * microtask/task still went unannounced for a second, textually
   * identical outcome, even though the DOM genuinely mutated twice
   * (confirmed via MutationObserver). This matches a well-documented,
   * cross-screen-reader limitation — NVDA issue nvaccess/nvda#19328,
   * a Safari/VoiceOver WebKit ticket, and other accessibility-engineering
   * sources all describe screen readers (Narrator included) failing to
   * re-announce aria-live content that reads identically to what they
   * last announced, EVEN when the underlying DOM mutation is real and
   * observable. The consistently-cited mitigation across those sources is
   * exactly this: clear, then restore after a real (commonly ~100ms)
   * delay — not a same-task write, which the accessibility-tree
   * serialization layer can still coalesce away. 100ms is negligible next
   * to the verdict round-trip itself (typically 900ms+ in this app).
   *
   * Cancellable (see `cancelPending`) so a newer click, a newer
   * navigation, a Q→Q clear, or component destruction can never let a
   * stale restore land after the fact — generation-guarded AND the timer
   * itself is cleared, not merely superseded.
   */
  private writeAnnouncement(text: string): void {
    this.cancelPending();
    const generation = this.announcementGeneration;
    this.announcedFeedback.set('');
    if (!text) return;
    this.pendingAnnouncerTimeoutId = setTimeout(() => {
      this.pendingAnnouncerTimeoutId = null;
      if (generation !== this.announcementGeneration) return; // superseded
      this.announcedFeedback.set(text);
    }, 100);
  }

  /**
   * Cancels any still-pending restore timer from `writeAnnouncement` above
   * (real cancellation via clearTimeout) and bumps the generation token as
   * a second guard. Must run before any direct `announcedFeedback.set(...)`
   * elsewhere (the Q→Q clear in OptionInteractionEffectsService, or a
   * component destroy hook) — otherwise a still-pending restore from the
   * question/click just left could fire 100ms later and overwrite that
   * fresh clear with stale text, exactly the bug this exists to prevent.
   */
  cancelPending(): void {
    if (this.pendingAnnouncerTimeoutId !== null) {
      clearTimeout(this.pendingAnnouncerTimeoutId);
      this.pendingAnnouncerTimeoutId = null;
    }
    this.announcementGeneration++;
  }
}
