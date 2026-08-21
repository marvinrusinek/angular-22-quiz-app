import { TestBed } from '@angular/core/testing';

import { AssessmentBuilderService } from './assessment-builder.service';
import { QuestionType } from '../../../models/question-type.enum';
import { QuizQuestion } from '../../../models/QuizQuestion.model';
import { questionsFromApiViews } from '../../../utils/topic-quiz-content';
import { setQuizDataCache } from '../../../quiz-data-cache';

/**
 * THE S6 INVARIANT: an API question in, a practice question out, and no answer
 * key materialises anywhere along the way.
 *
 * `resetOptions` used to write `correct: option.correct === true`, which is
 * FALSE for an option that carries no `correct` at all — so every API-sourced
 * practice option came out of the builder asserting it is WRONG. Absence has to
 * survive the clone, the shuffle and the AOTA pin.
 */

/** Exactly what `GET /quizzes/:id/questions` returns — no key of any kind. */
const API_VIEWS = [
  {
    questionText: 'Which operator flattens an inner observable?',
    type: 'multiple' as const,
    difficulty: 'intermediate',
    correctCount: 2,
    options: [
      { text: 'mergeMap' }, { text: 'tap' }, { text: 'switchMap' }, { text: 'filter' }
    ]
  },
  {
    questionText: 'Is a signal synchronous?',
    type: 'single' as const,
    difficulty: 'beginner',
    correctCount: 1,
    options: [{ text: 'Yes' }, { text: 'No' }]
  },
  {
    questionText: 'All of the above?',
    type: 'single' as const,
    difficulty: 'beginner',
    correctCount: 1,
    options: [{ text: 'One' }, { text: 'All of the above' }, { text: 'Two' }]
  }
];

function builder(): AssessmentBuilderService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [AssessmentBuilderService] });
  return TestBed.inject(AssessmentBuilderService);
}

/** Every option in a built assessment, flattened. */
function allOptions(questions: readonly QuizQuestion[]) {
  return questions.flatMap((q) => q.options ?? []);
}

describe('AssessmentBuilder — API questions in, no answer key out', () => {
  beforeEach(() => {
    // The local bank is deliberately EMPTY. If anything in the practice path
    // still reached for it, these tests would build nothing at all.
    setQuizDataCache([], []);
  });

  const pools = () =>
    new Map<string, readonly QuizQuestion[]>([['rxjs', questionsFromApiViews(API_VIEWS)]]);

  it('emits practice options with NO own `correct` property', () => {
    const built = builder().buildPractice(['rxjs'], 10, pools())!;
    expect(built.questions.length).toBe(3);

    for (const option of allOptions(built.questions)) {
      expect(Object.prototype.hasOwnProperty.call(option, 'correct')).toBe(false);
    }
  });

  it('never fabricates `correct: false`', () => {
    const built = builder().buildPractice(['rxjs'], 10, pools())!;
    const serialized = JSON.stringify(built.questions);
    expect(serialized).not.toContain('"correct"');
    expect(serialized).not.toContain('"correct":false');
  });

  it('never fabricates `answer` or `explanation`', () => {
    const built = builder().buildPractice(['rxjs'], 10, pools())!;
    for (const question of built.questions) {
      expect(Object.prototype.hasOwnProperty.call(question, 'answer')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(question, 'explanation')).toBe(false);
    }
    const serialized = JSON.stringify(built.questions);
    expect(serialized).not.toContain('"answer"');
    expect(serialized).not.toContain('"explanation"');
  });

  it('PRESERVES the declared type through cloning and shuffling', () => {
    const built = builder().buildPractice(['rxjs'], 10, pools())!;
    const multi = built.questions.find((q) => q.questionText?.startsWith('Which operator'));
    const single = built.questions.find((q) => q.questionText?.startsWith('Is a signal'));

    expect(multi!.type).toBe(QuestionType.MultipleAnswer);
    expect(single!.type).toBe(QuestionType.SingleAnswer);
  });

  it('still stamps sourceQuizId, assigns option ids and pins "All of the above" last', () => {
    const built = builder().buildPractice(['rxjs'], 10, pools())!;

    for (const question of built.questions) {
      expect(question.sourceQuizId).toBe('rxjs');
      for (const option of question.options ?? []) {
        expect(typeof option.optionId).toBe('number');
      }
    }

    const aota = built.questions.find((q) => q.questionText?.startsWith('All of the above'));
    const texts = (aota!.options ?? []).map((o) => o.text);
    expect(texts[texts.length - 1]).toBe('All of the above');
  });

  it('does NOT read the local catalog when pools are supplied', () => {
    // The cache is empty, yet a full session builds — proof the questions came
    // from the supplied API pool and nowhere else.
    const built = builder().buildPractice(['rxjs'], 10, pools());
    expect(built).not.toBeNull();
    expect(built!.questions.length).toBe(3);

    // …and without pools there is nothing to build from.
    expect(builder().buildPractice(['rxjs'], 10)).toBeNull();
  });

  it('MUTATION PROOF: restoring the old fabrication would break the invariant', () => {
    // The old line was `correct: option.correct === true`. Applied to an
    // API-sourced option it produces exactly this, which the invariant above
    // rejects — so the assertion genuinely constrains the production code.
    const apiOption = { optionId: 1, text: 'mergeMap' };
    const fabricated = { ...apiOption, correct: (apiOption as { correct?: boolean }).correct === true };

    expect(Object.prototype.hasOwnProperty.call(fabricated, 'correct')).toBe(true);
    expect(fabricated.correct).toBe(false);
    expect(JSON.stringify([fabricated])).toContain('"correct":false');
  });
});
