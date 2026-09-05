import { resolve } from 'node:path';

import { createQuizRepository, describeBank } from '../src/quiz/quiz.repository';
import { QuizDataFileError } from '../src/quiz/quiz.loader';
import { QuizDataError } from '../src/quiz/quiz.validation';
import { makeOptionId, makeQuestionId } from '../src/quiz/quiz.ids';
import { syntheticBankRepository } from './helpers/fixtures';

const BACKEND_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(BACKEND_ROOT, '..');
// S6p (Angular Stage 14): src/assets/data/quiz.json — the transitional
// Angular client asset this constant used to point at — is deleted; the
// client no longer fetches, caches, or bundles any answer-bearing bank. An
// explicit, synthetic test fixture (not real quiz content) replaces it for
// the "outside root" tests below, which test the allowOutsideRoot escape
// hatch itself and never depended on this being specifically the Angular
// asset — or on any real content at all.
const OUTSIDE_ROOT_FIXTURE = resolve(REPO_ROOT, 'test-fixtures/quiz-bank-sample.json');

// Stage 15: repository-BEHAVIOR coverage (ids, types, filtering, immutability,
// collisions) runs against the purpose-built synthetic bank in
// test/helpers/synthetic-quiz-bank.json, not the real private data file — a
// fresh clone with no private bank can run this whole suite.
function realRepo() {
  return syntheticBankRepository();
}

describe('loading the synthetic bank', () => {
  it('loads and validates successfully', () => {
    const repo = realRepo();
    expect(repo.stats.quizCount).toBe(7);
    expect(repo.stats.questionCount).toBe(66);
    expect(repo.stats.optionCount).toBe(195);
  });

  it('summarizes with COUNTS ONLY — no content in the startup log line', () => {
    const line = describeBank(realRepo().stats);
    expect(line).toBe('Loaded 7 quizzes, 66 questions, 195 options');
    expect(line).not.toMatch(/correct|explanation|option text|[?]/);
  });

  it('exposes metadata without questions, options, answers or explanations', () => {
    const metadata = realRepo().getQuizMetadata();
    expect(metadata).toHaveLength(7);
    const serialized = JSON.stringify(metadata);
    for (const banned of ['isCorrect', 'correct', 'explanation', 'options', 'questions']) {
      expect(serialized).not.toContain(banned);
    }
    expect(Object.keys(metadata[0]!).sort()).toEqual([
      'difficulty', 'facts', 'image', 'milestone', 'questionCount', 'quizId', 'summary'
    ]);
  });
});

describe('file-path safety', () => {
  it('rejects a missing file WITHOUT leaking the absolute path', () => {
    try {
      createQuizRepository({ dataPath: './data/does-not-exist.json' });
      throw new Error('expected a failure');
    } catch (err) {
      expect(err).toBeInstanceOf(QuizDataFileError);
      const message = (err as Error).message;
      expect(message).toMatch(/not found/i);
      expect(message).toContain('does-not-exist.json');   // basename only
      expect(message).not.toContain(BACKEND_ROOT);
      expect(message).not.toMatch(/[A-Za-z]:\\|\/home\/|\/srv\//);
    }
  });

  it('rejects a directory', () => {
    expect(() => createQuizRepository({ dataPath: './data' }))
      .toThrow(/directory, not a file/i);
  });

  it('rejects invalid JSON without quoting file contents', () => {
    expect(() => createQuizRepository({ dataPath: './package.json' }))
      .toThrow(QuizDataError);   // parses fine, but is not a quiz bank
  });

  it('BLOCKS a path escaping the backend directory', () => {
    expect(() => createQuizRepository({ dataPath: '../src/assets/data/quiz.json' }))
      .toThrow(/outside the backend directory/i);
  });

  it('blocks traversal segments', () => {
    expect(() => createQuizRepository({ dataPath: './data/../../etc/passwd' }))
      .toThrow(/outside the backend directory/i);
  });

  it('permits an explicit out-of-root fixture only when opted in (tests)', () => {
    const repo = createQuizRepository({
      dataPath: OUTSIDE_ROOT_FIXTURE,
      allowOutsideRoot: true
    });
    expect(repo.stats.questionCount).toBe(10);
  });
});

describe('no default path (Stage 16)', () => {
  // `createQuizRepository` is shared by the production path
  // (`createQuizRepositoryFromDatabase`, which always supplies `source` and
  // never `dataPath`) and the test/import tooling (which supplies `dataPath`
  // explicitly). This proves the shared factory has no silent third option:
  // calling it with neither is a configuration error, never a read of some
  // implicit file. There is no `backend/data/quiz.json` for that to even be.
  it('throws when called with neither `source` nor `dataPath`', () => {
    expect(() => createQuizRepository({}))
      .toThrow(/requires either .source. or an explicit .dataPath./i);
  });

  it('throws the same way when called with no arguments at all', () => {
    expect(() => createQuizRepository())
      .toThrow(/requires either .source. or an explicit .dataPath./i);
  });
});

describe('stable ids', () => {
  it('question ids follow <quizId>:q:<sourceIndex> and are unique bank-wide', () => {
    const repo = realRepo();
    const seen = new Set<string>();
    for (const meta of repo.getQuizMetadata()) {
      const quiz = repo.getQuizById(meta.quizId)!;
      quiz.questions.forEach((question, index) => {
        expect(question.questionId).toBe(makeQuestionId(meta.quizId, index));
        expect(question.sourceQuestionIndex).toBe(index);
        expect(seen.has(question.questionId)).toBe(false);
        seen.add(question.questionId);
      });
    }
    expect(seen.size).toBe(66);
  });

  it('option ids match the Angular formula exactly', () => {
    const repo = realRepo();
    for (const meta of repo.getQuizMetadata()) {
      const quiz = repo.getQuizById(meta.quizId)!;
      quiz.questions.forEach((question, qIndex) => {
        question.options.forEach((option, oIndex) => {
          // (questionIndex + 1) * 100 + (optionIndex + 1)
          expect(option.optionId).toBe((qIndex + 1) * 100 + (oIndex + 1));
          expect(option.optionId).toBe(makeOptionId(qIndex, oIndex));
        });
      });
    }
  });

  it('ids come from SOURCE ORDER, so they are position-derived and stable', () => {
    const repo = realRepo();
    const first = repo.getQuizById('fixture-widgets')?.questions[0];
    expect(first?.questionId).toBe('fixture-widgets:q:0');
    expect(first?.options[0]?.optionId).toBe(101);
  });
});

describe('option-id collisions are real and safely scoped', () => {
  it('the SAME numeric option id exists in different questions', () => {
    const repo = realRepo();
    const holders: string[] = [];
    for (const meta of repo.getQuizMetadata()) {
      for (const question of repo.getQuizById(meta.quizId)!.questions) {
        if (question.options.some((option) => option.optionId === 401)) {
          holders.push(question.questionId);
        }
      }
    }
    // Both fixture-widgets and fixture-gadgets have a question at source
    // index 3, so 401 legitimately exists in more than one question.
    expect(holders.length).toBeGreaterThan(1);
  });

  it('an option cannot be resolved ACROSS question boundaries', () => {
    const repo = realRepo();
    const questions = repo
      .getQuizMetadata()
      .flatMap((meta) => repo.getQuizById(meta.quizId)!.questions)
      .filter((question) => question.options.some((option) => option.optionId === 401));

    const [questionA, questionB] = questions;
    expect(questionA).toBeDefined();
    expect(questionB).toBeDefined();
    expect(questionA!.questionId).not.toBe(questionB!.questionId);

    // Both legitimately own an option numbered 401 …
    expect(repo.getOptionForQuestion(questionA!.questionId, 401)).toBeDefined();
    expect(repo.getOptionForQuestion(questionB!.questionId, 401)).toBeDefined();

    // … and they are DIFFERENT options, so the id alone means nothing.
    expect(repo.getOptionForQuestion(questionA!.questionId, 401)!.text)
      .not.toBe(repo.getOptionForQuestion(questionB!.questionId, 401)!.text);

    // An id belonging to another question is NOT resolvable here.
    const foreign = Math.max(...questionB!.options.map((o) => o.optionId)) + 5000;
    expect(repo.getOptionForQuestion(questionA!.questionId, foreign)).toBeUndefined();
  });

  it('returns undefined for unknown quiz, question and option ids', () => {
    const repo = realRepo();
    expect(repo.getQuizById('nope')).toBeUndefined();
    expect(repo.getQuestionById('nope:q:0')).toBeUndefined();
    expect(repo.getOptionForQuestion('nope:q:0', 101)).toBeUndefined();
    expect(repo.getOptionForQuestion('fixture-widgets:q:0', 999999)).toBeUndefined();
  });
});

describe('question types match current Angular behaviour', () => {
  it('classifies the synthetic bank as 45 single-select, 14 multiple, 7 trueFalse', () => {
    const repo = realRepo();
    const all = repo.getEligibleQuestions();
    const multiple = all.filter((q) => q.type === 'multiple');
    const trueFalse = all.filter((q) => q.type === 'trueFalse');
    const single = all.filter((q) => q.type === 'single');

    expect(multiple).toHaveLength(14);
    expect(trueFalse).toHaveLength(7);
    // single + trueFalse are both single-select, matching Angular's
    // `numCorrectAnswers > 1 ? MultipleAnswer : SingleAnswer`.
    expect(single.length + trueFalse.length).toBe(52);
  });

  it('every multiple question really has >1 correct option, and others exactly 1', () => {
    for (const question of realRepo().getEligibleQuestions()) {
      const correct = question.options.filter((option) => option.isCorrect).length;
      if (question.type === 'multiple') expect(correct).toBeGreaterThan(1);
      else expect(correct).toBe(1);
    }
  });

  it('PARITY: representative synthetic questions of each kind', () => {
    const repo = realRepo();
    const all = repo.getEligibleQuestions();

    const tf = all.find((q) => q.type === 'trueFalse')!;
    expect(tf.options).toHaveLength(2);
    expect(tf.options.map((o) => o.text.toLowerCase()).sort()).toEqual(['false', 'true']);

    const multi = all.find((q) => q.type === 'multiple')!;
    expect(multi.options.filter((o) => o.isCorrect).length).toBeGreaterThan(1);

    const single = all.find((q) => q.type === 'single')!;
    expect(single.options.filter((o) => o.isCorrect)).toHaveLength(1);

    // "All of the above" is present in this bank and must classify normally —
    // its handling is a DISPLAY concern (pinned last), not a type.
    const aota = all.find((q) =>
      q.options.some((o) => /all of the above/i.test(o.text))
    );
    if (aota) expect(['single', 'multiple']).toContain(aota.type);
  });
});

describe('eligibility filtering', () => {
  it('filters by topic', () => {
    const repo = realRepo();
    const questions = repo.getEligibleQuestions({ topicIds: ['fixture-widgets'] });
    expect(questions.length).toBeGreaterThan(0);
    expect(questions.every((q) => q.sourceQuizId === 'fixture-widgets')).toBe(true);
  });

  it('treats missing/empty topics and "mixed" as no filter', () => {
    const repo = realRepo();
    expect(repo.getEligibleQuestions()).toHaveLength(66);
    expect(repo.getEligibleQuestions({ topicIds: [] })).toHaveLength(66);
    expect(repo.getEligibleQuestions({ difficulty: 'mixed' })).toHaveLength(66);
  });

  it('filters by difficulty', () => {
    const repo = realRepo();
    const beginner = repo.getEligibleQuestions({ difficulty: 'beginner' });
    expect(beginner.length).toBeGreaterThan(0);
    expect(beginner.length).toBeLessThan(66);
  });

  it('returns nothing for an unknown topic', () => {
    expect(realRepo().getEligibleQuestions({ topicIds: ['nope'] })).toHaveLength(0);
  });
});

describe('immutability', () => {
  it('mutating a returned question does NOT change a later lookup', () => {
    const repo = realRepo();
    const before = repo.getQuestionById('fixture-widgets:q:0')!;
    const originalText = before.questionText;

    try {
      (before as { questionText: string }).questionText = 'TAMPERED';
    } catch {
      // Frozen objects throw in strict mode — equally acceptable.
    }

    expect(repo.getQuestionById('fixture-widgets:q:0')!.questionText).toBe(originalText);
  });

  it('mutating a returned OPTION does not change the master bank', () => {
    const repo = realRepo();
    const option = repo.getOptionForQuestion('fixture-widgets:q:0', 101)!;
    const originalCorrect = option.isCorrect;

    try {
      (option as { isCorrect: boolean }).isCorrect = !originalCorrect;
    } catch { /* frozen */ }

    expect(repo.getOptionForQuestion('fixture-widgets:q:0', 101)!.isCorrect).toBe(originalCorrect);
  });

  it('the returned collections cannot be spliced', () => {
    const repo = realRepo();
    const questions = repo.getEligibleQuestions({ topicIds: ['fixture-widgets'] });
    const count = questions.length;
    try {
      (questions as unknown as PrivateQuestionArray).push({} as never);
    } catch { /* frozen */ }
    expect(repo.getEligibleQuestions({ topicIds: ['fixture-widgets'] })).toHaveLength(count);
  });

  it('metadata is frozen too', () => {
    const metadata = realRepo().getQuizMetadata();
    expect(Object.isFrozen(metadata)).toBe(true);
    expect(Object.isFrozen(metadata[0])).toBe(true);
  });
});

type PrivateQuestionArray = { push: (value: never) => number };

describe('test isolation', () => {
  it('accepts a pre-parsed fixture with no file access', () => {
    const repo = createQuizRepository({
      source: {
        quizzes: [
          {
            quizId: 'fixture',
            milestone: 'Fixture',
            summary: '',
            image: '',
            questions: [
              {
                questionText: 'Q?',
                explanation: 'E',
                options: [{ text: 'a', correct: true }, { text: 'b' }]
              }
            ]
          }
        ]
      }
    });
    expect(repo.stats).toEqual({ quizCount: 1, questionCount: 1, optionCount: 2 });
    expect(repo.getQuestionById('fixture:q:0')?.type).toBe('single');
  });

  it('two repositories are independent', () => {
    const a = realRepo();
    const b = createQuizRepository({
      source: { quizzes: [{
        quizId: 'solo', milestone: 'Solo', questions: [{
          questionText: 'Q?', explanation: 'E',
          options: [{ text: 'a', correct: true }, { text: 'b' }]
        }]
      }] }
    });
    expect(a.stats.quizCount).toBe(7);
    expect(b.stats.quizCount).toBe(1);
  });
});

describe('run-mode parity (dev vs built)', () => {
  /**
   * Regression: rootDir was once derived from `__dirname`, which is
   * `src/quiz` under ts-node but `dist/src/quiz` after `npm run build`. A
   * relative `dataPath` resolved against THAT would land inside `dist/` after
   * a build and refuse to start. Anchoring to the process working directory
   * makes both modes agree, so this must keep passing from wherever the
   * suite is launched. Stage 15 removed the real bank the original version
   * of this test pointed at (`./data/quiz.json`) — the synthetic fixture
   * proves the identical path-resolution property without needing that file.
   */
  it('resolves a relative path against the working directory, not __dirname', () => {
    expect(process.cwd()).toBe(BACKEND_ROOT);
    expect(() =>
      createQuizRepository({ dataPath: './test/helpers/synthetic-quiz-bank.json' })
    ).not.toThrow();
  });

  it('an explicit rootDir still governs containment', () => {
    // rootDir = backend/src, so `../data/quiz.json` lands in backend/data —
    // a real file, but OUTSIDE the declared root, so it must still be refused.
    expect(() =>
      createQuizRepository({ dataPath: '../data/quiz.json', rootDir: resolve(BACKEND_ROOT, 'src') })
    ).toThrow(/outside the backend directory/i);
  });
});
