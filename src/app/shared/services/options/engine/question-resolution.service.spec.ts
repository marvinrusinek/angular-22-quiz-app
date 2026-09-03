import { TestBed } from '@angular/core/testing';

import { QuestionResolutionService } from './question-resolution.service';
import { QuizService } from '../../data/quiz.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { QuestionVerdictService } from '../../features/verdict/question-verdict.service';
import { TopicQuizTypeRegistry } from '../../api/topic-quiz-type-registry.service';

/**
 * THE REGRESSION: selecting 1 of 3 correct options on a multi-answer question
 * immediately highlighted all 3 as correct.
 *
 * Root cause: `resolveMultiPerfect` treated `quizService.isQuestionResolved`
 * (true the instant ANY submission resolves — a wrong single-answer pick
 * included) as if it meant "multi-answer PERFECT completion". A question can
 * be `isQuestionResolved === true` from an earlier, unrelated resolution path
 * while genuinely only 1 of N correct options has been picked; `multiPerfect`
 * must come from `isMultiAnswerPerfect`, which is written ONLY when the
 * authorized verdict reports full, clean completion.
 */
describe('QuestionResolutionService — multiPerfect authority (over-highlight regression)', () => {
  let service: QuestionResolutionService;
  let quizService: {
    isQuestionResolved: jest.Mock;
    isMultiAnswerPerfect: jest.Mock;
    questionCorrectness: Map<number, boolean>;
    getQuestionsInDisplayOrder: jest.Mock;
    questions: any[];
  };

  const QIDX = 2;

  beforeEach(() => {
    quizService = {
      isQuestionResolved: jest.fn().mockReturnValue(false),
      isMultiAnswerPerfect: jest.fn().mockReturnValue(false),
      questionCorrectness: new Map<number, boolean>(),
      getQuestionsInDisplayOrder: jest.fn().mockReturnValue([
        { questionText: 'Q0' }, { questionText: 'Q1' },
        { questionText: 'Which of the following statements are true? Select all that apply.', type: 'multiple' },
      ]),
      questions: [],
    };

    TestBed.configureTestingModule({
      providers: [
        QuestionResolutionService,
        { provide: QuizService, useValue: quizService },
        {
          provide: SelectedOptionService,
          useValue: { getSelectedOptionsForQuestion: jest.fn().mockReturnValue([]) },
        },
        {
          provide: QuestionVerdictService,
          useValue: {
            verdictFor: jest.fn().mockReturnValue(null),
          },
        },
        { provide: TopicQuizTypeRegistry, useValue: { isMultiAnswer: jest.fn().mockReturnValue(true) } },
      ],
    });

    service = TestBed.inject(QuestionResolutionService);
  });

  it('does NOT report fullyResolvedCorrect from isQuestionResolved alone (the old, buggy union)', () => {
    // The signal that used to leak in: "resolved by SOME means" is true...
    quizService.isQuestionResolved.mockReturnValue(true);
    // ...but the question was NEVER a clean, full multi-answer completion.
    quizService.isMultiAnswerPerfect.mockReturnValue(false);

    const res = service.resolveQuestionState(QIDX, { includeDot: false, includeSelections: false });

    expect(res.multiPerfect).toBe(false);
    expect(res.fullyResolvedCorrect).toBe(false);
  });

  it('DOES report fullyResolvedCorrect once isMultiAnswerPerfect is genuinely true', () => {
    quizService.isQuestionResolved.mockReturnValue(true);
    quizService.isMultiAnswerPerfect.mockReturnValue(true);

    const res = service.resolveQuestionState(QIDX, { includeDot: false, includeSelections: false });

    expect(res.multiPerfect).toBe(true);
    expect(res.fullyResolvedCorrect).toBe(true);
  });
});
