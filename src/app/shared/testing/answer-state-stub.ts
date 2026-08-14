import { signal } from '@angular/core';

/**
 * TEST-ONLY. The answer-state surface of QuizService, backed by real Maps.
 *
 * The three states became signal-backed and private, reached through semantic
 * accessors, so that async verdict arrival notifies OnPush consumers. Specs
 * that stub QuizService need the accessors, and most of them assert against the
 * maps directly — so this exposes both, over the same storage.
 *
 * The `*Sig` readers exist because components subscribe to them to be woken by
 * an arrival. They are backed by a version counter rather than by fresh Map
 * identities, so that the direct handles above stay the same object a spec can
 * seed and then read back. The consequence, stated so nobody is surprised by
 * it: seeding through a direct handle does NOT notify — go through
 * `markMultiAnswerComplete()` etc. when a test depends on a re-render.
 *
 * Spread it into a QuizService stub:
 *
 *     { provide: QuizService, useValue: { quizId: 'rxjs', ...answerStateStub() } }
 */
export function answerStateStub() {
  const multiAnswerCompletion = new Map<number, boolean>();
  const multiAnswerPerfect = new Map<number, boolean>();
  const questionResolved = new Map<number, boolean>();

  const version = signal(0);
  const bump = () => version.update((v) => v + 1);

  return {
    // Direct handles, so existing `.get(idx)` assertions keep reading the
    // same storage the accessors write to.
    multiAnswerCompletion,
    multiAnswerPerfect,
    questionResolved,

    multiAnswerCompletionSig: () => { version(); return multiAnswerCompletion; },
    multiAnswerPerfectSig: () => { version(); return multiAnswerPerfect; },
    questionResolvedSig: () => { version(); return questionResolved; },

    isMultiAnswerComplete: (i: number) => multiAnswerCompletion.get(i) === true,
    isMultiAnswerPerfect: (i: number) => multiAnswerPerfect.get(i) === true,
    isQuestionResolved: (i: number) => questionResolved.get(i) === true,

    markMultiAnswerComplete: (i: number) => { multiAnswerCompletion.set(i, true); bump(); },
    markMultiAnswerPerfect: (i: number) => { multiAnswerPerfect.set(i, true); bump(); },
    markQuestionResolved: (i: number) => { questionResolved.set(i, true); bump(); },

    clearAnswerStateAt: (i: number) => {
      multiAnswerCompletion.delete(i);
      multiAnswerPerfect.delete(i);
      questionResolved.delete(i);
      bump();
    },
    clearAllAnswerState: () => {
      multiAnswerCompletion.clear();
      multiAnswerPerfect.clear();
      questionResolved.clear();
      bump();
    }
  };
}
