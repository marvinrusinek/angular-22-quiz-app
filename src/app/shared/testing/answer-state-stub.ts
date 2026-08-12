/**
 * TEST-ONLY. The answer-state surface of QuizService, backed by real Maps.
 *
 * The three states became signal-backed and private, reached through semantic
 * accessors, so that async verdict arrival notifies OnPush consumers. Specs
 * that stub QuizService need the accessors, and most of them assert against the
 * maps directly — so this exposes both, over the same storage.
 *
 * Spread it into a QuizService stub:
 *
 *     { provide: QuizService, useValue: { quizId: 'rxjs', ...answerStateStub() } }
 */
export function answerStateStub() {
  const multiAnswerCompletion = new Map<number, boolean>();
  const multiAnswerPerfect = new Map<number, boolean>();
  const questionResolved = new Map<number, boolean>();

  return {
    // Direct handles, so existing `.get(idx)` assertions keep reading the
    // same storage the accessors write to.
    multiAnswerCompletion,
    multiAnswerPerfect,
    questionResolved,

    isMultiAnswerComplete: (i: number) => multiAnswerCompletion.get(i) === true,
    isMultiAnswerPerfect: (i: number) => multiAnswerPerfect.get(i) === true,
    isQuestionResolved: (i: number) => questionResolved.get(i) === true,

    markMultiAnswerComplete: (i: number) => { multiAnswerCompletion.set(i, true); },
    markMultiAnswerPerfect: (i: number) => { multiAnswerPerfect.set(i, true); },
    markQuestionResolved: (i: number) => { questionResolved.set(i, true); },

    clearAnswerStateAt: (i: number) => {
      multiAnswerCompletion.delete(i);
      multiAnswerPerfect.delete(i);
      questionResolved.delete(i);
    },
    clearAllAnswerState: () => {
      multiAnswerCompletion.clear();
      multiAnswerPerfect.clear();
      questionResolved.clear();
    }
  };
}
