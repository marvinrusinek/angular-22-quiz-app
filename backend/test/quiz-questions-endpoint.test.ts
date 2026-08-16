import request from 'supertest';
import type { Express } from 'express';

import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { fromPool, type DatabaseHandle } from '../src/db/database';
import { migrate } from '../src/db/migrate';
import { createSessionRepository } from '../src/interview/session.repository';
import { InterviewSessionService } from '../src/interview/session.service';
import { seededRandomSource } from '../src/interview/assessment.random';
import {
  createQuizRepositoryFromDatabase,
  type QuizRepository
} from '../src/quiz/quiz.repository';
import { createTestPool } from './helpers/pg-mem-pool';

/**
 * GET /api/quizzes/:quizId/questions
 *
 * Topic Quiz delivery. The contract carries NO identifiers — a question is
 * addressed by its exact text within a quiz — and no correctness or
 * explanations. Everything is served from PostgreSQL; there is no JSON path.
 */

const CLOCK = () => 1_700_000_000_000;

/**
 * Fixture chosen to exercise the round-trip hazards found in the real bank:
 * HTML-like option text, entities in question text, non-ASCII characters and
 * whitespace-sensitive content.
 */
const BANK = {
  quizzes: [
    {
      quizId: 'rxjs',
      milestone: 'RxJS',
      summary: 'Streams',
      image: 'assets/img/rxjs.png',
      difficulty: 'beginner',
      facts: ['A fact that must not be served here'],
      questions: [
        {
          questionText: 'Which answer is correct?',          // contains "correct"
          explanation: 'Because the id of the explanation is here.',
          options: [
            { text: 'A multicast observable', correct: true },
            { text: 'A pipe' }
          ]
        },
        {
          // HTML-like option text, exactly as the real bank contains.
          questionText: 'In a standalone component, which selectors apply?',
          explanation: 'Router outlet explanation.',
          options: [
            { text: '<router-outlet>', correct: true },
            { text: '<ng-template>', correct: true },
            { text: "this.http.get<User>('/api/users/1')" }
          ]
        },
        {
          // Entities and tags in the question text (rendered via innerHTML).
          questionText: 'How else can Array&lt;number&gt; be written in <code>TypeScript</code>?',
          explanation: 'Generic array syntax.',
          options: [{ text: 'number[]', correct: true }, { text: 'Array' }]
        },
        {
          // Non-ASCII and whitespace-sensitive content.
          questionText: '  Does   café — naïve — résumé  survive?  ',
          explanation: 'Unicode explanation — em dash.',
          options: [{ text: 'Yes — précisément', correct: true }, { text: 'Non' }]
        },
        {
          questionText: 'Is this true or false?',
          explanation: 'True/false derivation.',
          options: [{ text: 'True', correct: true }, { text: 'False' }]
        }
      ]
    },
    {
      quizId: 'signals',
      milestone: 'Signals',
      summary: 'Reactivity',
      image: 'assets/img/signals.png',
      difficulty: 'advanced',
      facts: [],
      questions: [
        {
          questionText: 'What does computed() return?',
          explanation: 'A read-only signal.',
          options: [{ text: 'A read-only signal', correct: true }, { text: 'A promise' }]
        }
      ]
    }
  ]
};

let handle: DatabaseHandle;
let app: Express;

/** Seed PostgreSQL exactly as the import script does. */
async function seed(db: DatabaseHandle, source = BANK): Promise<void> {
  for (const [quizIndex, quiz] of source.quizzes.entries()) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO quizzes (quiz_id, milestone, summary, image, difficulty, facts_json, display_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [quiz.quizId, quiz.milestone, quiz.summary, quiz.image, quiz.difficulty,
       JSON.stringify(quiz.facts), quizIndex]
    );
    const quizPk = Number(rows[0]!['id']);

    for (const [questionIndex, question] of quiz.questions.entries()) {
      const correctCount = question.options.filter((o) => 'correct' in o).length;
      const texts = question.options.map((o) => o.text.trim().toLowerCase()).sort();
      const type = correctCount > 1
        ? 'multiple'
        : (question.options.length === 2 && texts[0] === 'false' && texts[1] === 'true')
          ? 'trueFalse'
          : 'single';

      const inserted = await db.query<{ id: string }>(
        `INSERT INTO questions
           (quiz_pk, question_text, question_type, explanation, display_order)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [quizPk, question.questionText, type, question.explanation, questionIndex]
      );
      const questionPk = Number(inserted.rows[0]!['id']);

      for (const [optionIndex, option] of question.options.entries()) {
        await db.query(
          `INSERT INTO options (question_pk, option_text, display_order, is_correct)
           VALUES ($1, $2, $3, $4)`,
          [questionPk, option.text, optionIndex, 'correct' in option ? 1 : 0]
        );
      }
    }
  }
}

function buildApp(quizRepository: QuizRepository, database: DatabaseHandle): Express {
  const sessionRepository = createSessionRepository(database);
  const interviewSessionService = new InterviewSessionService({
    quizRepository,
    sessionRepository,
    now: CLOCK,
    random: seededRandomSource(7)
  });
  return createApp(
    loadConfig({ NODE_ENV: 'test', ALLOWED_ORIGINS: 'http://localhost:4200' } as NodeJS.ProcessEnv),
    { quizRepository, sessionRepository, interviewSessionService }
  );
}

beforeEach(async () => {
  handle = fromPool(createTestPool().pool, 'pg-mem');
  await migrate(handle, { now: CLOCK });
  await seed(handle);
  app = buildApp(await createQuizRepositoryFromDatabase(handle), handle);
});
afterEach(() => handle.close());

/** Recursively collect PROPERTY NAMES — never values. */
function keysDeep(value: unknown, out: string[] = []): string[] {
  if (value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) { for (const item of value) keysDeep(item, out); return out; }
  for (const [key, nested] of Object.entries(value)) { out.push(key); keysDeep(nested, out); }
  return out;
}

const BANNED_KEYS = [
  'questionId', 'optionId', 'id', 'questionIndex', 'optionIndex',
  'correct', 'isCorrect', 'is_correct', 'correctOptionIds',
  'answerKey', 'expectedAnswers', 'explanation',
  'legacyQuestionId', 'legacyOptionId', 'sourceIndex', 'displayOrder'
];

const get = (quizId: string) => request(app).get(`/api/quizzes/${quizId}/questions`);

describe('contract shape', () => {
  it('returns the quiz and all of its questions', async () => {
    const res = await get('rxjs');
    expect(res.status).toBe(200);
    expect(res.body.quizId).toBe('rxjs');
    expect(res.body.questions).toHaveLength(5);
  });

  it('has EXACTLY the allowed top-level and nested key sets', async () => {
    const res = await get('rxjs');

    expect(Object.keys(res.body).sort()).toEqual(['questions', 'quizId']);
    for (const question of res.body.questions) {
      expect(Object.keys(question).sort())
        .toEqual(['correctCount', 'difficulty', 'options', 'questionText', 'type']);
      for (const option of question.options) {
        expect(Object.keys(option)).toEqual(['text']);
      }
    }
  });

  it('preserves SOURCE question order', async () => {
    const res = await get('rxjs');
    expect(res.body.questions.map((q: { questionText: string }) => q.questionText)).toEqual(
      BANK.quizzes[0]!.questions.map((q) => q.questionText)
    );
  });

  it('preserves SOURCE option order', async () => {
    const res = await get('rxjs');
    expect(res.body.questions[1].options.map((o: { text: string }) => o.text))
      .toEqual(['<router-outlet>', '<ng-template>', "this.http.get<User>('/api/users/1')"]);
  });

  it('preserves the explicit question type for single, multiple and trueFalse', async () => {
    const res = await get('rxjs');
    const types = res.body.questions.map((q: { type: string }) => q.type);
    expect(types[0]).toBe('single');
    expect(types[1]).toBe('multiple');
    expect(types[4]).toBe('trueFalse');
    expect(new Set(types)).toEqual(new Set(['single', 'multiple', 'trueFalse']));
  });

  it('carries the quiz-level difficulty on every question', async () => {
    expect((await get('rxjs')).body.questions.every((q: { difficulty: string }) => q.difficulty === 'beginner')).toBe(true);
    expect((await get('signals')).body.questions[0].difficulty).toBe('advanced');
  });

  it('404s for an unknown quiz', async () => {
    const res = await get('does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBeDefined();
  });

  it('404s for a RETIRED quiz, indistinguishably from an unknown one', async () => {
    await handle.query(`UPDATE quizzes SET status = 'retired' WHERE quiz_id = 'signals'`);
    const retiredApp = buildApp(await createQuizRepositoryFromDatabase(handle), handle);

    const retired = await request(retiredApp).get('/api/quizzes/signals/questions');
    const unknown = await request(retiredApp).get('/api/quizzes/nope/questions');
    expect(retired.status).toBe(404);
    expect(retired.body).toEqual(unknown.body);   // no information leak
  });

  it('sets Cache-Control: no-store', async () => {
    expect((await get('rxjs')).headers['cache-control']).toBe('no-store');
  });
});

describe('text fidelity — the response IS the contract', () => {
  it('returns HTML-like option text byte for byte', async () => {
    const options = (await get('rxjs')).body.questions[1].options;
    expect(options[0].text).toBe('<router-outlet>');
    expect(options[1].text).toBe('<ng-template>');
    expect(options[2].text).toBe("this.http.get<User>('/api/users/1')");
  });

  it('returns question text containing entities and tags unchanged', async () => {
    expect((await get('rxjs')).body.questions[2].questionText)
      .toBe('How else can Array&lt;number&gt; be written in <code>TypeScript</code>?');
  });

  it('preserves non-ASCII characters and is NFC-stable', async () => {
    const text = (await get('rxjs')).body.questions[3].questionText;
    expect(text).toBe('  Does   café — naïve — résumé  survive?  ');
    expect(text.normalize('NFC')).toBe(text);
    expect((await get('rxjs')).body.questions[3].options[0].text).toBe('Yes — précisément');
  });

  it('preserves leading, trailing and internal WHITESPACE exactly', async () => {
    // The stored string is what a client echoes back, so trimming here would
    // break lookup on the way in.
    const text = (await get('rxjs')).body.questions[3].questionText;
    expect(text.startsWith('  ')).toBe(true);
    expect(text.endsWith('  ')).toBe(true);
    expect(text).toContain('Does   café');
  });

  it('every string matches the stored value exactly', async () => {
    const res = await get('rxjs');
    const source = BANK.quizzes[0]!;

    res.body.questions.forEach((question: { questionText: string; options: { text: string }[] }, i: number) => {
      expect(question.questionText).toBe(source.questions[i]!.questionText);
      question.options.forEach((option, j) => {
        expect(option.text).toBe(source.questions[i]!.options[j]!.text);
      });
    });
  });
});

describe('raw-response security', () => {
  it('contains NO banned property names anywhere', async () => {
    const keys = new Set(keysDeep((await get('rxjs')).body));
    for (const bannedKey of BANNED_KEYS) {
      expect(keys.has(bannedKey)).toBe(false);
    }
    expect([...keys].sort()).toEqual(['correctCount', 'difficulty', 'options', 'questionText', 'questions', 'quizId', 'text', 'type']);
  });

  it('does not leak the answer key or explanations for ANY quiz', async () => {
    for (const quizId of ['rxjs', 'signals']) {
      const keys = new Set(keysDeep((await get(quizId)).body));
      expect(keys.has('explanation')).toBe(false);
      expect(keys.has('correct')).toBe(false);
      expect(keys.has('isCorrect')).toBe(false);
    }
  });

  it('does not leak quiz facts through this route', async () => {
    expect(new Set(keysDeep((await get('rxjs')).body)).has('facts')).toBe(false);
  });

  it('ALLOWS question text containing the words "correct", "id" and "explanation"', async () => {
    // The guard inspects property NAMES, never values. A question legitimately
    // reading "Which answer is correct?" must pass.
    const res = await get('rxjs');
    expect(res.status).toBe(200);
    expect(res.body.questions[0].questionText).toBe('Which answer is correct?');
  });

  it('draining EVERY quiz still yields no correctness', async () => {
    // A client that calls every public read endpoint must still be unable to
    // assemble an answer key.
    const list = await request(app).get('/api/quizzes');
    const everything: unknown[] = [list.body];
    for (const quiz of list.body.quizzes) {
      everything.push((await get(quiz.quizId)).body);
      everything.push((await request(app).get(`/api/quizzes/${quiz.quizId}`)).body);
    }

    const keys = new Set(keysDeep(everything));
    for (const bannedKey of ['correct', 'isCorrect', 'correctOptionIds', 'explanation', 'answerKey']) {
      expect(keys.has(bannedKey)).toBe(false);
    }
  });
});

describe('the QUIZ_QUESTIONS policy is enforced by the guard', () => {
  it('rejects a response carrying an identifier', async () => {
    const { findPolicyViolation } = await import('../src/api/response-policy');

    for (const key of ['questionId', 'optionId', 'id', 'displayOrder', 'legacyOptionId']) {
      const violation = findPolicyViolation(
        { quizId: 'rxjs', questions: [{ questionText: 'q', options: [{ text: 't', [key]: 1 }] }] },
        'QUIZ_QUESTIONS'
      );
      expect(violation?.key).toBe(key);
    }
  });

  it('rejects correctness and explanation', async () => {
    const { findPolicyViolation } = await import('../src/api/response-policy');

    for (const key of ['correct', 'isCorrect', 'is_correct', 'correctOptionIds', 'explanation']) {
      expect(findPolicyViolation({ questions: [{ [key]: true }] }, 'QUIZ_QUESTIONS')?.key).toBe(key);
    }
  });

  it('is STRICTER than ACTIVE_ASSESSMENT, not a reuse of it', async () => {
    const { findPolicyViolation } = await import('../src/api/response-policy');
    const body = { questions: [{ questionId: 'rxjs:q:0', options: [{ optionId: 101 }] }] };

    // Interview Mode's contract legitimately carries these…
    expect(findPolicyViolation(body, 'ACTIVE_ASSESSMENT')).toBeNull();
    // …and the Topic Quiz contract must not.
    expect(findPolicyViolation(body, 'QUIZ_QUESTIONS')).not.toBeNull();
  });

  it('permits the legitimate Topic Quiz body', async () => {
    const { findPolicyViolation } = await import('../src/api/response-policy');
    expect(findPolicyViolation(
      {
        quizId: 'rxjs',
        questions: [{
          questionText: 'Which answer is correct?',
          type: 'single',
          difficulty: 'beginner',
          options: [{ text: 'An id, an explanation, and a correct answer' }]
        }]
      },
      'QUIZ_QUESTIONS'
    )).toBeNull();
  });
});

describe('existing routes are unchanged', () => {
  it('GET /api/quizzes remains metadata-only', async () => {
    const res = await request(app).get('/api/quizzes');
    expect(res.status).toBe(200);
    const keys = new Set(keysDeep(res.body));
    expect(keys.has('questions')).toBe(false);
    expect(keys.has('options')).toBe(false);
    expect(keys.has('explanation')).toBe(false);
  });

  it('GET /api/quizzes/:quizId remains metadata-only', async () => {
    const res = await request(app).get('/api/quizzes/rxjs');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort())
      .toEqual(['difficulty', 'image', 'milestone', 'questionCount', 'quizId', 'summary']);
  });

  it('Interview routes still exist and still require authentication', async () => {
    expect((await request(app).get('/api/interview-sessions/is_x')).status).toBe(401);
    expect((await request(app).post('/api/interview-sessions/is_x/submit')).status).toBe(401);
  });

  it('private file paths remain 404 and nothing is served statically', async () => {
    for (const path of [
      '/quiz.json', '/data/quiz.json', '/api/quiz.json',
      '/assets/data/quiz.json', '/backend/data/quiz.json',
      '/api/quizzes/rxjs/questions/../../../data/quiz.json'
    ]) {
      expect((await request(app).get(path)).status).toBe(404);
    }
  });
});

/**
 * CORRECT-COUNT METADATA (S2).
 *
 * The "(N answers are correct)" banner has always been drawn by counting
 * `option.correct` in the browser, which made a piece of the answer key a
 * RENDERING dependency. The count now travels as question metadata.
 *
 * The disclosure is deliberate and narrow: cardinality, never identity. The
 * number is already on screen before the user answers, so serving it changes
 * where it comes from, not what a player knows.
 */
describe('correctCount metadata', () => {
  it('reports the real count for a single-answer question', async () => {
    const res = await get('rxjs');
    const q = res.body.questions.find(
      (question: { questionText: string }) => question.questionText === 'Which answer is correct?'
    );
    expect(q.correctCount).toBe(1);
    expect(typeof q.correctCount).toBe('number');
  });

  it('reports the real count for a MULTI-answer question', async () => {
    const res = await get('rxjs');
    const q = res.body.questions.find((question: { questionText: string }) =>
      question.questionText.startsWith('In a standalone component'));
    expect(q.correctCount).toBe(2);
    expect(q.type).toBe('multiple');
  });

  it('reports a count for trueFalse without changing its type', async () => {
    const res = await get('rxjs');
    const q = res.body.questions.find(
      (question: { questionText: string }) => question.questionText === 'Is this true or false?'
    );
    expect(q.type).toBe('trueFalse');
    expect(q.correctCount).toBe(1);
  });

  it('is present on EVERY question, as a non-negative integer', async () => {
    for (const quizId of ['rxjs', 'signals']) {
      for (const q of (await get(quizId)).body.questions) {
        expect(Number.isInteger(q.correctCount)).toBe(true);
        expect(q.correctCount).toBeGreaterThanOrEqual(0);
        expect(q.correctCount).toBeLessThanOrEqual(q.options.length);
      }
    }
  });

  it('matches the seeded bank exactly, question by question', async () => {
    for (const quiz of BANK.quizzes) {
      const served = (await get(quiz.quizId)).body.questions;
      for (const [i, question] of quiz.questions.entries()) {
        const expected = question.options.filter((o) => 'correct' in o).length;
        expect(served[i].correctCount).toBe(expected);
      }
    }
  });

  it('DISCLOSES CARDINALITY BUT NOT IDENTITY', async () => {
    // The whole justification for the field. Knowing two of three options are
    // correct must not narrow WHICH two — the options carry text and nothing
    // else, so the count cannot be attached to any particular one.
    const res = await get('rxjs');
    for (const q of res.body.questions) {
      for (const option of q.options) {
        expect(Object.keys(option)).toEqual(['text']);
      }
    }
  });

  it('adds no banned key alongside it', async () => {
    const keys = new Set(keysDeep((await get('rxjs')).body));
    for (const banned of BANNED_KEYS) expect(keys.has(banned)).toBe(false);
    // …and the new key really is there, so the assertion above is not vacuous.
    expect(keys.has('correctCount')).toBe(true);
  });
});
