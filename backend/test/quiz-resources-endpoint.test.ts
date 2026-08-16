import request from 'supertest';
import type { Express } from 'express';

import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { fromPool, type DatabaseHandle } from '../src/db/database';
import { migrate } from '../src/db/migrate';
import { createSessionRepository } from '../src/interview/session.repository';
import {
  createQuizRepositoryFromDatabase,
  createQuizRepository,
  type QuizRepository
} from '../src/quiz/quiz.repository';
import { createTestPool } from './helpers/pg-mem-pool';

/**
 * GET /api/quizzes/:quizId/resources
 *
 * The Results-page "Brush up your knowledge" links. These were the last piece
 * of the quiz bank with no source outside `data/quiz.json`, which is what made
 * them a blocker for removing BOTH public copies of that file.
 *
 * They are public by nature — outbound links to third-party documentation —
 * so they are served under PUBLIC_METADATA rather than a new policy. What that
 * buys is enforced here: the response guard bans the answer-key fields
 * independently of what the DTO chooses to emit.
 */

const CLOCK = () => 1_700_000_000_000;

const BANK = {
  quizzes: [
    {
      quizId: 'rxjs', milestone: 'RxJS', summary: 'Streams',
      image: 'assets/img/rxjs.png', difficulty: 'beginner', facts: [],
      questions: [{
        questionText: 'Which answer is correct?',
        explanation: 'The explanation nobody here may see.',
        options: [{ text: 'A multicast observable', correct: true }, { text: 'A pipe' }]
      }]
    },
    {
      // Deliberately has NO resources: the common case (12 of 20 real quizzes).
      quizId: 'signals', milestone: 'Signals', summary: 'Reactivity',
      image: 'assets/img/signals.png', difficulty: 'advanced', facts: [],
      questions: [{
        questionText: 'What does computed() return?',
        explanation: 'A read-only signal.',
        options: [{ text: 'A read-only signal', correct: true }, { text: 'A promise' }]
      }]
    }
  ]
};

/**
 * Inserted OUT of display order, so a passing order assertion proves the query
 * sorts rather than merely returning insertion order.
 */
const RESOURCES: readonly { order: number; title: string; url: string; host: string }[] = [
  { order: 2, title: 'Third link', url: 'https://example.test/three', host: 'Example' },
  { order: 0, title: 'First link', url: 'https://rxjs.dev', host: 'RxJS website' },
  { order: 1, title: 'Second link', url: 'https://example.test/two', host: '' }
];

let handle: DatabaseHandle;
let app: Express;

async function seed(db: DatabaseHandle): Promise<void> {
  for (const [quizIndex, quiz] of BANK.quizzes.entries()) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO quizzes (quiz_id, milestone, summary, image, difficulty, facts_json, display_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [quiz.quizId, quiz.milestone, quiz.summary, quiz.image, quiz.difficulty,
       JSON.stringify(quiz.facts), quizIndex]
    );
    const quizPk = Number(rows[0]!['id']);

    for (const [questionIndex, question] of quiz.questions.entries()) {
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO questions (quiz_pk, question_text, question_type, explanation, display_order)
         VALUES ($1, $2, 'single', $3, $4) RETURNING id`,
        [quizPk, question.questionText, question.explanation, questionIndex]
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

    if (quiz.quizId === 'rxjs') {
      for (const resource of RESOURCES) {
        await db.query(
          `INSERT INTO quiz_resources (quiz_pk, title, url, host, display_order)
           VALUES ($1, $2, $3, $4, $5)`,
          [quizPk, resource.title, resource.url, resource.host, resource.order]
        );
      }
    }
  }
}

function buildApp(quizRepository: QuizRepository, database: DatabaseHandle): Express {
  return createApp(
    loadConfig({ NODE_ENV: 'test', ALLOWED_ORIGINS: 'http://localhost:4200' } as NodeJS.ProcessEnv),
    { quizRepository, sessionRepository: createSessionRepository(database) }
  );
}

beforeEach(async () => {
  handle = fromPool(createTestPool().pool, 'pg-mem');
  await migrate(handle, { now: CLOCK });
  await seed(handle);
  app = buildApp(await createQuizRepositoryFromDatabase(handle), handle);
});
afterEach(() => handle.close());

const get = (quizId: string) => request(app).get(`/api/quizzes/${quizId}/resources`);

/** Recursively collect PROPERTY NAMES — never values. */
function keysDeep(value: unknown, out: string[] = []): string[] {
  if (value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) { for (const item of value) keysDeep(item, out); return out; }
  for (const [key, nested] of Object.entries(value)) { out.push(key); keysDeep(nested, out); }
  return out;
}

describe('contract shape', () => {
  it('returns a quiz\'s resources', async () => {
    const res = await get('rxjs');
    expect(res.status).toBe(200);
    expect(res.body.quizId).toBe('rxjs');
    expect(res.body.resources).toHaveLength(3);
  });

  it('carries exactly title, url and host on each item', async () => {
    const res = await get('rxjs');
    for (const resource of res.body.resources) {
      expect(Object.keys(resource).sort()).toEqual(['host', 'title', 'url']);
    }
  });

  it('preserves the stored display order, not insertion order', async () => {
    const res = await get('rxjs');
    expect(res.body.resources.map((r: { title: string }) => r.title))
      .toEqual(['First link', 'Second link', 'Third link']);
  });

  it('serves an empty host as an empty string rather than omitting it', async () => {
    const res = await get('rxjs');
    expect(res.body.resources[1].host).toBe('');
  });
});

describe('quizzes without resources', () => {
  it('answers 200 with an empty list, not 404', async () => {
    // "This quiz has no links" is an ordinary answer — 12 of the 20 real
    // quizzes are in this state. A 404 would say the quiz does not exist.
    const res = await get('signals');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ quizId: 'signals', resources: [] });
  });
});

describe('unknown quiz', () => {
  it('404s, matching the questions route', async () => {
    const res = await get('does-not-exist');
    expect(res.status).toBe(404);
  });

  it('does not disclose whether the id was retired or never existed', async () => {
    const unknown = await get('never-existed');
    const retired = await get('also-never-existed');
    expect(unknown.status).toBe(retired.status);
    expect(unknown.body).toEqual(retired.body);
  });
});

describe('the endpoint leaks nothing from the bank', () => {
  const BANNED_KEYS = [
    'questions', 'options', 'correct', 'isCorrect', 'is_correct',
    'correctOptionIds', 'correctOptionTexts', 'answerKey', 'expectedAnswers',
    'explanation', 'questionId', 'optionId', 'id', 'quiz_pk', 'question_pk',
    'displayOrder', 'display_order', 'legacyQuestionId', 'legacyOptionId',
    'receipt', 'questionReceipt', 'attemptId', 'remainingCorrectCount'
  ];

  it('emits none of the answer-key or internal field names', async () => {
    const res = await get('rxjs');
    const keys = new Set(keysDeep(res.body));
    for (const banned of BANNED_KEYS) expect(keys.has(banned)).toBe(false);
  });

  it('emits no question, option or explanation TEXT', async () => {
    const body = JSON.stringify((await get('rxjs')).body);
    expect(body).not.toContain('Which answer is correct?');
    expect(body).not.toContain('A multicast observable');
    expect(body).not.toContain('The explanation nobody here may see.');
  });

  it('emits no quiz metadata beyond the id', async () => {
    const body = JSON.stringify((await get('rxjs')).body);
    expect(body).not.toContain('RxJS website'.replace('RxJS website', 'Streams'));  // summary
    expect(body).not.toContain('assets/img/rxjs.png');                              // image
    expect(body).not.toContain('beginner');                                         // difficulty
  });
});

describe('the repository never falls back to a file', () => {
  it('serves empty resources when built without them', async () => {
    // The file-sourced construction path passes no resources at all. It must
    // answer empty rather than reaching for `data/quiz.json`.
    const repository = createQuizRepository({ source: BANK });
    expect(repository.getResourcesForQuiz('rxjs')).toEqual([]);
    expect(repository.getResourcesForQuiz('unknown')).toEqual([]);
  });

  it('returns a frozen list a caller cannot mutate', async () => {
    const repository = await createQuizRepositoryFromDatabase(handle);
    const list = repository.getResourcesForQuiz('rxjs');
    expect(Object.isFrozen(list)).toBe(true);
    expect(() => (list as unknown as { push: (v: unknown) => void }).push({})).toThrow();
  });

  it('reads the same list on every call without re-querying', async () => {
    const repository = await createQuizRepositoryFromDatabase(handle);
    // Held in memory at startup, exactly like the bank — so closing the
    // database must not stop it answering.
    await handle.close();
    expect(repository.getResourcesForQuiz('rxjs')).toHaveLength(3);
    // Reopen so afterEach's close() is harmless.
    handle = fromPool(createTestPool().pool, 'pg-mem');
  });
});
