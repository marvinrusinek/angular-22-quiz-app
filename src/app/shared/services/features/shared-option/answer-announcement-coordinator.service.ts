import { Service, inject } from '@angular/core';

import { buildHeadingInputs } from '@shared/utils/heading-inputs';
import { shouldShowFet } from '@shared/utils/heading-model';
import { composeAnswerAnnouncement } from '@shared/utils/compose-answer-announcement';

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
 * Composes the ONE coordinated announcement for an answer outcome — see
 * compose-answer-announcement.ts for why this exists and the exact rules.
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

  /**
   * `feedbackText`/`isCorrect` describe THIS click's own verdict (from
   * FeedbackComponent, which already derives both correctly — see its
   * `determineFeedbackMessageClass`). Everything else needed to classify
   * the event (is the explanation due right now? what does the CURRENT
   * selection-message guidance say?) is read fresh, for the CURRENT
   * question index, at call time.
   */
  compose(feedbackText: string, isCorrect: boolean): string {
    const idx = this.quizService.currentQuestionIndex ?? 0;
    const inputs = buildHeadingInputs({
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
    });

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
}
