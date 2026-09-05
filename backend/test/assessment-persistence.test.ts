import {
  buildInterviewAssessment,
  validateBuildRequest
} from '../src/interview/assessment.builder';
import { seededRandomSource } from '../src/interview/assessment.random';
import type { CreateSessionInput } from '../src/interview/session.types';
import type { GeneratedInterviewSnapshot } from '../src/interview/assessment.types';
import { syntheticBankRepository } from './helpers/fixtures';
import { memoryDb, reopen, type TestDb } from './helpers/db';

/**
 * Internal integration: builder output → session repository → read back.
 *
 * This proves the two halves of Stage 4 and Stage 5 agree on a contract, ahead
 * of the session service that will join them in Stage 6. NO HTTP route is
 * involved and none exists.
 */

const CREATED_AT = 1_700_000_000_000;

/**
 * The mapping the future session service will perform. Kept in the test for
 * now so no production code implies a session can be created yet.
 */
function toCreateInput(
  snapshot: GeneratedInterviewSnapshot,
  overrides: Partial<CreateSessionInput> = {}
): CreateSessionInput {
  return {
    id: 'sess_build_1',
    tokenHash: 'b'.repeat(64),
    attemptId: 'att_build_1',
    config: {
      difficulty: snapshot.config.difficulty,
      topicIds: snapshot.config.topicIds,
      questionCount: snapshot.config.questionCount
    },
    durationSeconds: snapshot.durationSeconds,
    createdAt: CREATED_AT,
    expiresAt: CREATED_AT + snapshot.durationSeconds * 1000,
    questions: snapshot.questions.map((question) => ({
      position: question.position,
      questionId: question.questionId,
      sourceQuizId: question.sourceQuizId,
      questionText: question.questionText,
      type: question.questionType,
      explanation: question.explanation,
      options: question.options.map((option) => ({
        optionId: option.optionId,
        text: option.optionText,
        displayOrder: option.displayOrder,
        isCorrect: option.isCorrect
      }))
    })),
    ...overrides
  };
}

function build(seed = 99): GeneratedInterviewSnapshot {
  const repository = syntheticBankRepository();
  const config = validateBuildRequest(
    { difficulty: 'mixed', topicIds: ['fixture-widgets', 'fixture-gadgets', 'fixture-gizmos'], questionCount: 20 },
    repository
  );
  return buildInterviewAssessment(config, repository, seededRandomSource(seed));
}

let ctx: TestDb;
beforeEach(async () => { ctx = await memoryDb(); });
afterEach(() => ctx.handle.close());

describe('builder output persists faithfully', () => {
  it('stores and reads back the assessment unchanged', async () => {
    const snapshot = build();
    await ctx.repo.createSessionSnapshot(toCreateInput(snapshot));

    const stored = (await ctx.repo.getSessionSnapshot('sess_build_1'))!;
    expect(stored.questions).toHaveLength(20);

    for (const [index, generated] of snapshot.questions.entries()) {
      const persisted = stored.questions[index]!;

      expect(persisted.position).toBe(generated.position);
      expect(persisted.questionId).toBe(generated.questionId);
      expect(persisted.sourceQuizId).toBe(generated.sourceQuizId);
      expect(persisted.questionText).toBe(generated.questionText);
      expect(persisted.type).toBe(generated.questionType);
      expect(persisted.explanation).toBe(generated.explanation);

      // Option ORDER, ids, text and correctness all survive the round trip.
      expect(persisted.options.map((o) => o.optionId))
        .toEqual(generated.options.map((o) => o.optionId));
      expect(persisted.options.map((o) => o.displayOrder))
        .toEqual(generated.options.map((o) => o.displayOrder));
      expect(persisted.options.map((o) => o.text))
        .toEqual(generated.options.map((o) => o.optionText));
      expect(persisted.options.map((o) => o.isCorrect))
        .toEqual(generated.options.map((o) => o.isCorrect));
    }
  });

  it('preserves the generated QUESTION order, not source order', async () => {
    const snapshot = build(1234);
    await ctx.repo.createSessionSnapshot(toCreateInput(snapshot));
    const stored = (await ctx.repo.getSessionSnapshot('sess_build_1'))!;

    expect(stored.questions.map((q) => q.questionId))
      .toEqual(snapshot.questions.map((q) => q.questionId));
  });

  it('keeps the config and duration the builder derived', async () => {
    const snapshot = build();
    await ctx.repo.createSessionSnapshot(toCreateInput(snapshot));
    const stored = (await ctx.repo.getSessionById('sess_build_1'))!;

    expect(stored.durationSeconds).toBe(1800);
    expect(stored.config.questionCount).toBe(20);
    expect(stored.config.topicIds).toEqual(['fixture-widgets', 'fixture-gadgets', 'fixture-gizmos']);
    expect(stored.config.difficulty).toBe('mixed');
  });

  it('an assessment containing the same option id in two questions persists fine', async () => {
    const snapshot = build(77);
    const idCounts = new Map<number, number>();
    for (const question of snapshot.questions) {
      for (const option of question.options) {
        idCounts.set(option.optionId, (idCounts.get(option.optionId) ?? 0) + 1);
      }
    }
    // Option ids repeat across questions by construction — that is the point.
    expect([...idCounts.values()].some((count) => count > 1)).toBe(true);

    await expect(ctx.repo.createSessionSnapshot(toCreateInput(snapshot))).resolves.toBeDefined();
  });

  it('survives a fresh connection with the frozen snapshot intact', async () => {
    // Under SQLite this closed and reopened a FILE. The database is a server
    // now, so the equivalent question is whether anything was being served out
    // of process memory: a brand-new handle and repository over the same
    // database must see the identical snapshot.
    const snapshot = build(555);
    await ctx.repo.createSessionSnapshot(toCreateInput(snapshot));

    const fresh = reopen(ctx.handle);
    const stored = (await fresh.repo.getSessionSnapshot('sess_build_1'))!;

    expect(stored.questions.map((q) => q.questionId))
      .toEqual(snapshot.questions.map((q) => q.questionId));
    expect(stored.questions[0]!.options.map((o) => o.displayOrder))
      .toEqual(snapshot.questions[0]!.options.map((o) => o.displayOrder));
  });

  it('two builds of the same config persist as independent sessions', async () => {
    const first = build(1);
    const second = build(2);

    await ctx.repo.createSessionSnapshot(toCreateInput(first));
    await ctx.repo.createSessionSnapshot(
      toCreateInput(second, { id: 'sess_build_2', attemptId: 'att_build_2' })
    );

    const a = (await ctx.repo.getSessionSnapshot('sess_build_1'))!;
    const b = (await ctx.repo.getSessionSnapshot('sess_build_2'))!;
    expect(a.questions.map((q) => q.questionId)).not.toEqual(b.questions.map((q) => q.questionId));
  });
});

describe('the builder does not leak into HTTP', () => {
  it('generated snapshots carry correctness — which is why they stay backend-side', async () => {
    const snapshot = build();
    const serialized = JSON.stringify(snapshot);
    // A blunt reminder of the stakes: this object MUST NOT be returned by any
    // route. Stage 6 maps it through toActiveInterviewQuestionDto instead.
    expect(serialized).toContain('isCorrect');
    expect(serialized).toContain('explanation');
  });
});
