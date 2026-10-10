import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of } from 'rxjs';

import { AnswerAnnouncementCoordinatorService } from './answer-announcement-coordinator.service';

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
import { QuestionType } from '@shared/models/question-type.enum';

/**
 * Focused coverage for AnswerAnnouncementCoordinatorService — the single
 * root-singleton source of truth for Topic Quiz's persistent announcer (see
 * its own class-level doc comment for why the announcer's STATE lives here
 * rather than on SharedOptionComponent: a viewChild query from QuizComponent
 * can never reach the actual <app-shared-option> instance, which lives
 * several component-template boundaries below it).
 *
 * compose-answer-announcement.spec.ts already covers the pure answer-
 * outcome composition rules in isolation; this file exercises the SHARED
 * gatherHeadingInputs() wiring (both announce methods) and the
 * clear-then-100ms-restore write mechanism end to end, through the public
 * API only (compose()/composeQuestionArrivalAnnouncement() are private).
 *
 * Fakes mirror codelab-quiz-content.component.spec.ts's own `fakes()` for
 * the identical buildHeadingInputs() dependencies, so "is the explanation
 * due right now" resolves identically here and at the heading — these
 * fakes are not independently invented.
 */
describe('AnswerAnnouncementCoordinatorService', () => {
  const IDX = 0;
  const RESTORE_DELAY_MS = 150; // comfortably above the real 100ms delay

  function configure(
    question: { questionText: string; type?: QuestionType; options: Array<{ correct?: boolean }> },
    overrides: { isNavigatingToPrevious?: boolean; isTimedOut?: boolean; hasInteracted?: boolean; correctCountOf?: number | null; isMultiAnswer?: boolean | null } = {}
  ) {
    TestBed.configureTestingModule({
      providers: [
        { provide: ExplanationTextService, useValue: {
          isExplanationTextDisplayed$: of(false),
          formattedExplanationSig: signal(null),
          formattedExplanations: {},
          fetByIndex: new Map<number, string>(),
          timeoutFetByIndex: new Map<number, string>(),
          fetBypassForQuestion: new Map<number, boolean>(),
        } },
        { provide: QuestionVerdictService, useValue: { states: signal(new Map()), verdictFor: () => null } },
        // bannerCorrectCount reads `correctCountOf`, NOT `correctCount` — the
        // banner is DECLARED metadata (see heading-inputs.ts's own comment),
        // never a tally of the options array.
        { provide: TopicQuizTypeRegistry, useValue: {
          isMultiAnswer: () => overrides.isMultiAnswer ?? null,
          correctCountOf: () => overrides.correctCountOf ?? null,
        } },
        { provide: QuizNavigationService, useValue: { isNavigatingToPreviousSig: signal(!!overrides.isNavigatingToPrevious) } },
        { provide: QuizQuestionManagerService, useValue: { getNumberOfCorrectAnswersText: (n: number) => `(${n} answers are correct)` } },
        { provide: QuizService, useValue: {
          quizId: 'test-quiz',
          currentQuestionIndex: IDX,
          getQuestionsInDisplayOrder: () => [question],
        } },
        { provide: QuizStateService, useValue: {
          lastInteractionTimeSig: signal(0),
          hasUserInteracted: () => !!overrides.hasInteracted,
          wasInteractedThisVisit: () => !!overrides.hasInteracted,
        } },
        { provide: SelectedOptionService, useValue: { selectedOptionSig: signal(null), selectedOptionsMap: new Map() } },
        { provide: TimerService, useValue: {
          expiredForQuestionIndexSig: signal(overrides.isTimedOut ? IDX : -1),
          expiredOnArrivalSig: signal(-1),
        } },
        { provide: FeedbackPolicyService, useValue: { feedbackMode: signal('immediate') } },
        { provide: SelectionMessageService, useValue: { getCurrentMessage: () => '' } },
      ],
    });
    return TestBed.inject(AnswerAnnouncementCoordinatorService);
  }

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  describe('announceQuestionArrival', () => {
    it('clears immediately, then restores the question\'s own text after the delay', async () => {
      const svc = configure({
        questionText: 'Which lifecycle hook runs once?',
        type: QuestionType.SingleAnswer,
        options: [{ correct: true }, {}],
      });

      svc.announceQuestionArrival();
      expect(svc.announcedFeedback()).toBe('');

      await wait(RESTORE_DELAY_MS);
      expect(svc.announcedFeedback()).toBe('Which lifecycle hook runs once?');
    });

    it('includes the multi-answer banner, matching what the heading itself would show', async () => {
      const svc = configure(
        { questionText: 'Which are structural directives?', type: QuestionType.MultipleAnswer, options: [{ correct: true }, { correct: true }, {}] },
        { isMultiAnswer: true, correctCountOf: 2 }
      );

      svc.announceQuestionArrival();
      await wait(RESTORE_DELAY_MS);

      const result = svc.announcedFeedback();
      expect(result).toContain('Which are structural directives?');
      expect(result).toContain('2 answers are correct');
    });

    it('on a genuine revisit to an answered question, still announces the QUESTION text, never the FET', async () => {
      const svc = configure(
        { questionText: 'Which lifecycle hook runs once?', type: QuestionType.SingleAnswer, options: [{ correct: true }, {}] },
        { isNavigatingToPrevious: true, hasInteracted: false }
      );

      svc.announceQuestionArrival();
      await wait(RESTORE_DELAY_MS);

      const result = svc.announcedFeedback();
      expect(result).toBe('Which lifecycle hook runs once?');
      expect(result.toLowerCase()).not.toContain('because');
    });

    it('strips HTML from the question text for the spoken announcement', async () => {
      const svc = configure({
        questionText: 'What does <code>ngOnInit</code> do?',
        type: QuestionType.SingleAnswer,
        options: [{ correct: true }, {}],
      });

      svc.announceQuestionArrival();
      await wait(RESTORE_DELAY_MS);
      expect(svc.announcedFeedback()).toBe('What does ngOnInit do?');
    });

    it('a second call before the first restore fires cancels the first — only the LATEST navigation is ever restored', async () => {
      const svc = configure({
        questionText: 'First question text',
        type: QuestionType.SingleAnswer,
        options: [{ correct: true }, {}],
      });

      svc.announceQuestionArrival();
      // Immediately supersede with a second call before the 100ms restore
      // fires — simulates rapid Next/Next.
      svc.announceQuestionArrival();
      await wait(RESTORE_DELAY_MS);

      // Both calls compose the SAME text here (same fake question), but the
      // generation guard must still have let exactly one restore land, not
      // thrown or left the signal stuck at ''.
      expect(svc.announcedFeedback()).toBe('First question text');
    });
  });

  describe('announceOutcome', () => {
    it('restores the composed feedback text after the delay', async () => {
      const svc = configure({
        questionText: 'Which lifecycle hook runs once?',
        type: QuestionType.SingleAnswer,
        options: [{ correct: true }, {}],
      });

      svc.announceOutcome('Not this one, try again!', false);
      expect(svc.announcedFeedback()).toBe('');
      await wait(RESTORE_DELAY_MS);
      expect(svc.announcedFeedback()).toBe('Not this one, try again!');
    });
  });

  describe('cancelPending', () => {
    it('prevents a pending restore from landing after it runs', async () => {
      const svc = configure({
        questionText: 'Some question',
        type: QuestionType.SingleAnswer,
        options: [{ correct: true }, {}],
      });

      svc.announceQuestionArrival();
      svc.cancelPending();
      await wait(RESTORE_DELAY_MS);

      // The cancelled restore never landed — the clear from the original
      // call is the last real write.
      expect(svc.announcedFeedback()).toBe('');
    });
  });
});
