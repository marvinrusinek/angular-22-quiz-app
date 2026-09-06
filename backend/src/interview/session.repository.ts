import type { DatabaseHandle, Queryable } from '../db/database';

import type { CodeSnippetLanguage, QuestionType } from '../quiz/quiz.types';
import { computeTimeUsedSeconds, scoreInterview } from './result.scoring';
import {
  assertResultInvariants,
  parseFrozenResult,
  type FrozenInterviewResult
} from './result.types';
import type {
  CreateSessionInput,
  InterviewSessionConfig,
  InterviewSessionRecord,
  InterviewSessionSnapshot,
  SessionAnswerRecord,
  SessionOptionSnapshot,
  SessionQuestionSnapshot,
  SessionStatus
} from './session.types';

/**
 * Interview session persistence.
 *
 * Every statement is PARAMETERIZED — no value is ever interpolated into SQL.
 * Raw rows never leave this module: each read converts snake_case columns into
 * an explicit object, and every JSON column is parsed AND revalidated, because
 * "this process wrote it" is not a guarantee that it is still well-formed.
 */

export type SessionRepositoryErrorCategory =
  | 'VALIDATION'
  | 'CONSTRAINT'
  | 'NOT_FOUND'
  | 'CORRUPT_DATA'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_NOT_ACTIVE'
  | 'SESSION_EXPIRED'
  | 'QUESTION_NOT_IN_SESSION'
  | 'OPTION_NOT_IN_QUESTION'
  | 'INVALID_SELECTION_COUNT';

export class SessionRepositoryError extends Error {
  public override readonly name = 'SessionRepositoryError';
  /** Coarse category for logs and HTTP translation. Never carries values or SQL. */
  public readonly category: SessionRepositoryErrorCategory;

  constructor(category: SessionRepositoryErrorCategory, message: string) {
    super(message);
    this.category = category;
  }
}

export interface SaveAnswerInput {
  readonly sessionId: string;
  readonly questionId: string;
  /** The COMPLETE current selection. Empty clears the answer. */
  readonly selectedOptionIds: readonly number[];
  /** Captured ONCE by the caller and used for the whole transaction. */
  readonly now: number;
}

export interface SavedAnswerState {
  readonly questionId: string;
  readonly selectedOptionIds: readonly number[];
  readonly answeredCount: number;
  readonly questionCount: number;
}

export interface SetFlaggedInput {
  readonly sessionId: string;
  readonly questionId: string;
  readonly flagged: boolean;
  /** Captured ONCE by the caller and used for the whole transaction. */
  readonly now: number;
}

export interface FlaggedState {
  readonly questionId: string;
  readonly flagged: boolean;
}

const QUESTION_TYPES: readonly QuestionType[] = ['single', 'multiple', 'trueFalse'];
const CODE_SNIPPET_LANGUAGES: readonly CodeSnippetLanguage[] = ['typescript', 'html', 'css', 'json'];

// ── row shapes (module-private) ─────────────────────────────────────

interface SessionRow {
  id: string;
  token_hash: string;
  status: string;
  config_json: string;
  duration_seconds: number;
  created_at: number;
  expires_at: number;
  submitted_at: number | null;
  submitted_by_expiry: number;
  result_json: string | null;
  attempt_id: string;
}

interface QuestionRow {
  position: number;
  question_id: string;
  source_quiz_id: string;
  question_text: string;
  question_type: string;
  explanation: string;
  flagged: number;
  code: string | null;
  code_language: string | null;
  code_filename: string | null;
}

interface OptionRow {
  question_position: number;
  option_id: number;
  option_text: string;
  display_order: number;
  is_correct: number;
}

interface AnswerRow {
  question_position: number;
  selected_option_ids: string;
  updated_at: number;
}

// ── JSON validators ─────────────────────────────────────────────────

function parseConfig(raw: string, sessionId: string): InterviewSessionConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SessionRepositoryError('CORRUPT_DATA', `Session ${sessionId} has unreadable config`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SessionRepositoryError('CORRUPT_DATA', `Session ${sessionId} has an invalid config`);
  }

  const candidate = parsed as Record<string, unknown>;
  const topicIds = candidate['topicIds'];
  const questionCount = candidate['questionCount'];
  const difficulty = candidate['difficulty'];

  if (
    typeof difficulty !== 'string' ||
    !Array.isArray(topicIds) ||
    !topicIds.every((id): id is string => typeof id === 'string') ||
    typeof questionCount !== 'number' ||
    !Number.isInteger(questionCount)
  ) {
    throw new SessionRepositoryError('CORRUPT_DATA', `Session ${sessionId} has an invalid config`);
  }

  const config: InterviewSessionConfig = {
    difficulty,
    topicIds: [...topicIds],
    questionCount,
    ...(typeof candidate['presetId'] === 'string' ? { presetId: candidate['presetId'] } : {}),
    ...(typeof candidate['presetName'] === 'string' ? { presetName: candidate['presetName'] } : {})
  };
  return config;
}

/**
 * Validate a stored answer array: an array of unique integers, non-empty.
 * Full correctness/type-arity checking belongs to the answer service (Stage 7);
 * this is the structural floor.
 */
export function parseSelectedOptionIds(raw: string, context: string): readonly number[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SessionRepositoryError('CORRUPT_DATA', `${context} has unreadable selections`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new SessionRepositoryError('CORRUPT_DATA', `${context} has invalid selections`);
  }
  const ids: number[] = [];
  for (const value of parsed) {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new SessionRepositoryError('CORRUPT_DATA', `${context} has a non-integer selection`);
    }
    if (ids.includes(value)) {
      throw new SessionRepositoryError('CORRUPT_DATA', `${context} has duplicate selections`);
    }
    ids.push(value);
  }
  return ids;
}

function parseResult(raw: string | null, sessionId: string): unknown | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new SessionRepositoryError('CORRUPT_DATA', `Session ${sessionId} has an unreadable result`);
  }
}

function toStatus(raw: string, sessionId: string): SessionStatus {
  if (raw === 'active' || raw === 'submitted' || raw === 'expired') return raw;
  throw new SessionRepositoryError('CORRUPT_DATA', `Session ${sessionId} has an unknown status`);
}

function toQuestionType(raw: string, context: string): QuestionType {
  const match = QUESTION_TYPES.find((type) => type === raw);
  if (!match) {
    throw new SessionRepositoryError('CORRUPT_DATA', `${context} has an unknown question type`);
  }
  return match;
}

function toCodeSnippetLanguage(raw: string | null, context: string): CodeSnippetLanguage {
  const match = CODE_SNIPPET_LANGUAGES.find((language) => language === raw);
  if (!match) {
    throw new SessionRepositoryError('CORRUPT_DATA', `${context} has an unknown code snippet language`);
  }
  return match;
}

// ── input validation (TypeScript-side) ──────────────────────────────

function validateCreateInput(input: CreateSessionInput): void {
  const fail = (message: string): never => {
    throw new SessionRepositoryError('VALIDATION', message);
  };

  if (input.questions.length === 0) fail('A session must contain at least one question');

  const positions = new Set<number>();
  const questionIds = new Set<string>();

  for (const question of input.questions) {
    if (!Number.isInteger(question.position) || question.position < 0) {
      fail('Question position must be a non-negative integer');
    }
    if (positions.has(question.position)) fail('Duplicate question position');
    positions.add(question.position);

    if (questionIds.has(question.questionId)) fail('Duplicate question id within the session');
    questionIds.add(question.questionId);

    if (question.options.length === 0) fail('A question must contain at least one option');

    const optionIds = new Set<number>();
    const displayOrders = new Set<number>();
    for (const option of question.options) {
      if (optionIds.has(option.optionId)) fail('Duplicate option id within a question');
      optionIds.add(option.optionId);
      if (displayOrders.has(option.displayOrder)) fail('Duplicate display order within a question');
      displayOrders.add(option.displayOrder);
    }
  }

  // Positions must be a dense 0..n-1 range so ordering is unambiguous.
  for (let i = 0; i < input.questions.length; i++) {
    if (!positions.has(i)) fail('Question positions must be contiguous from zero');
  }
}

// ── repository ──────────────────────────────────────────────────────

/**
 * The narrow record used for bearer verification. Deliberately separate from
 * InterviewSessionRecord so the token hash is fetched only where it is actually
 * needed, instead of riding along on every read.
 */
export interface SessionAuthenticationRecord {
  readonly sessionId: string;
  readonly tokenHash: string;
  readonly status: SessionStatus;
  readonly expiresAt: number;
}

export interface SessionRepository {
  createSessionSnapshot(input: CreateSessionInput): Promise<InterviewSessionRecord>;
  /** Token-hash access, scoped to verification. */
  getSessionAuthenticationRecord(sessionId: string): Promise<SessionAuthenticationRecord | null>;
  /** Atomically flip an ACTIVE session to expired when its deadline has passed. */
  markExpiredIfDue(sessionId: string, now: number): Promise<InterviewSessionRecord | null>;
  getSessionById(sessionId: string): Promise<InterviewSessionRecord | null>;
  getSessionByAttemptId(attemptId: string): Promise<InterviewSessionRecord | null>;
  getSessionSnapshot(sessionId: string): Promise<InterviewSessionSnapshot | null>;
  getAnswers(sessionId: string): Promise<readonly SessionAnswerRecord[]>;
  markExpired(sessionId: string, expiredAt: number): Promise<InterviewSessionRecord>;
  deleteSession(sessionId: string): Promise<boolean>;
  /**
   * Save or clear ONE question's selection, entirely inside a single
   * transaction: state check, expiry check, membership checks and the write all
   * happen on one pinned connection between BEGIN and COMMIT.
   */
  saveAnswer(input: SaveAnswerInput): Promise<SavedAnswerState>;
  /**
   * Set or clear the Mark-for-Review flag for ONE question. Never touches
   * `session_answers` — marking never creates, requires or implies an answer.
   */
  setFlagged(input: SetFlaggedInput): Promise<FlaggedState>;
  /**
   * Score and close the session in ONE transaction. Idempotent: an already
   * submitted session returns its stored result and is never rescored.
   */
  finalizeSession(input: FinalizeSessionInput): Promise<FrozenInterviewResult>;
  /** The frozen result, or null when the session has not been submitted. */
  getSubmittedResult(sessionId: string): Promise<FrozenInterviewResult | null>;
}

export interface FinalizeSessionInput {
  readonly sessionId: string;
  /** Captured ONCE by the caller and used for the whole transaction. */
  readonly now: number;
  /** Resolved at finalization and frozen into the result. */
  readonly topicTitleFor: (topicId: string) => string;
}

export function createSessionRepository(db: DatabaseHandle): SessionRepository {
  // ── SQL ───────────────────────────────────────────────────────────
  // Parameterized with $n placeholders. Values are NEVER interpolated: the
  // frozen snapshot contains user-visible question and option text, and string
  // building here would be an injection surface with the answer key behind it.

  const INSERT_SESSION = `
    INSERT INTO interview_sessions
      (id, token_hash, status, config_json, duration_seconds,
       created_at, expires_at, submitted_at, submitted_by_expiry, result_json, attempt_id)
    VALUES ($1, $2, 'active', $3, $4, $5, $6, NULL, 0, NULL, $7)
  `;
  const INSERT_QUESTION = `
    INSERT INTO session_questions
      (session_id, position, question_id, source_quiz_id, question_text, question_type, explanation,
       code, code_language, code_filename)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  `;
  const INSERT_OPTION = `
    INSERT INTO session_options
      (session_id, question_position, option_id, option_text, display_order, is_correct)
    VALUES ($1, $2, $3, $4, $5, $6)
  `;

  const SELECT_SESSION = 'SELECT * FROM interview_sessions WHERE id = $1';
  const SELECT_BY_ATTEMPT = 'SELECT * FROM interview_sessions WHERE attempt_id = $1';
  const SELECT_QUESTIONS = `
    SELECT position, question_id, source_quiz_id, question_text, question_type, explanation, flagged,
           code, code_language, code_filename
    FROM session_questions WHERE session_id = $1 ORDER BY position
  `;
  const SELECT_OPTIONS = `
    SELECT question_position, option_id, option_text, display_order, is_correct
    FROM session_options WHERE session_id = $1 ORDER BY question_position, display_order
  `;
  const SELECT_ANSWERS = `
    SELECT question_position, selected_option_ids, updated_at
    FROM session_answers WHERE session_id = $1 ORDER BY question_position
  `;
  const EXPIRE_NOW = `
    UPDATE interview_sessions SET status = 'expired' WHERE id = $1 AND status = 'active'
  `;
  const EXPIRE_IF_DUE = `
    UPDATE interview_sessions SET status = 'expired'
    WHERE id = $1 AND status = 'active' AND expires_at <= $2
  `;
  const SELECT_AUTH =
    'SELECT id, token_hash, status, expires_at FROM interview_sessions WHERE id = $1';
  const DELETE_SESSION = 'DELETE FROM interview_sessions WHERE id = $1';

  const SELECT_STATE_FOR_UPDATE =
    'SELECT id, status, expires_at FROM interview_sessions WHERE id = $1';
  const SELECT_QUESTION_BY_PUBLIC_ID = `
    SELECT position, question_type FROM session_questions
    WHERE session_id = $1 AND question_id = $2
  `;
  const UPDATE_FLAGGED = `
    UPDATE session_questions SET flagged = $1
    WHERE session_id = $2 AND position = $3
  `;
  const SELECT_OPTION_IDS_FOR_QUESTION = `
    SELECT option_id FROM session_options
    WHERE session_id = $1 AND question_position = $2
  `;
  const UPSERT_ANSWER = `
    INSERT INTO session_answers (session_id, question_position, selected_option_ids, updated_at)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (session_id, question_position)
    DO UPDATE SET selected_option_ids = excluded.selected_option_ids,
                  updated_at          = excluded.updated_at
  `;
  const DELETE_ANSWER =
    'DELETE FROM session_answers WHERE session_id = $1 AND question_position = $2';
  const COUNT_ANSWERS = 'SELECT COUNT(*) AS n FROM session_answers WHERE session_id = $1';
  const COUNT_QUESTIONS = 'SELECT COUNT(*) AS n FROM session_questions WHERE session_id = $1';

  const SELECT_RESULT = 'SELECT status, result_json FROM interview_sessions WHERE id = $1';
  const SELECT_FOR_FINALIZE = `
    SELECT id, status, config_json, duration_seconds, created_at, expires_at, result_json
    FROM interview_sessions WHERE id = $1
  `;
  /**
   * Conditional UPDATE: it only fires while the session is NOT already
   * submitted. Two concurrent finalizations therefore cannot both write — the
   * loser sees 0 rows affected and reads back the winner's frozen result.
   */
  const WRITE_RESULT = `
    UPDATE interview_sessions
    SET status = 'submitted', submitted_at = $1, submitted_by_expiry = $2, result_json = $3
    WHERE id = $4 AND status <> 'submitted'
  `;

  // ── row mapping ───────────────────────────────────────────────────

  /**
   * pg returns BIGINT as a STRING, to avoid silently losing precision on values
   * beyond 2^53. Every BIGINT here is an epoch-millisecond timestamp, which is
   * ~1.7e12 and therefore far inside Number.MAX_SAFE_INTEGER, so converting is
   * safe. Skipping this would make `createdAt` the string "1700000000000" and
   * break every comparison in the app.
   */
  const num = (value: string | number | null | undefined): number => Number(value);

  function toRecord(row: SessionRow): InterviewSessionRecord {
    return {
      id: row.id,
      tokenHash: row.token_hash,
      status: toStatus(row.status, row.id),
      config: parseConfig(row.config_json, row.id),
      durationSeconds: num(row.duration_seconds),
      createdAt: num(row.created_at),
      expiresAt: num(row.expires_at),
      submittedAt: row.submitted_at === null ? null : num(row.submitted_at),
      submittedByExpiry: num(row.submitted_by_expiry) === 1,
      result: parseResult(row.result_json, row.id),
      attemptId: row.attempt_id
    };
  }

  function toOptions(rows: readonly OptionRow[]): Map<number, SessionOptionSnapshot[]> {
    const byPosition = new Map<number, SessionOptionSnapshot[]>();
    for (const row of rows) {
      const list = byPosition.get(num(row.question_position)) ?? [];
      list.push({
        optionId: num(row.option_id),
        text: row.option_text,
        displayOrder: num(row.display_order),
        isCorrect: num(row.is_correct) === 1
      });
      byPosition.set(num(row.question_position), list);
    }
    return byPosition;
  }

  function toQuestions(
    rows: readonly QuestionRow[],
    optionsByPosition: Map<number, SessionOptionSnapshot[]>,
    context: string
  ): SessionQuestionSnapshot[] {
    return rows.map((row) => ({
      position: num(row.position),
      questionId: row.question_id,
      sourceQuizId: row.source_quiz_id,
      questionText: row.question_text,
      type: toQuestionType(row.question_type, `${context} question ${num(row.position)}`),
      explanation: row.explanation,
      options: optionsByPosition.get(num(row.position)) ?? [],
      flagged: num(row.flagged) === 1,
      ...(row.code
        ? {
            codeSnippet: {
              language: toCodeSnippetLanguage(row.code_language, `${context} question ${num(row.position)}`),
              code: row.code,
              ...(row.code_filename ? { filename: row.code_filename } : {})
            }
          }
        : {})
    }));
  }

  /**
   * Postgres SQLSTATE classification.
   *
   * Classified on the CODE, never the message: the text is not part of any
   * contract and can quote the values being inserted. (The SQLite port made
   * this mistake once already, matching on message text that differed between
   * environments and silently degrading every violation to the generic branch.)
   *
   *   23505 unique_violation      23503 foreign_key_violation
   *   23514 check_violation       23502 not_null_violation
   */
  function classifyWriteError(err: unknown): never {
    const code = (err as { code?: unknown }).code;
    const sqlState = typeof code === 'string' ? code : '';

    if (sqlState === '23505') {
      throw new SessionRepositoryError('CONSTRAINT', 'Session violates a uniqueness constraint');
    }
    if (sqlState.startsWith('23')) {
      throw new SessionRepositoryError('CONSTRAINT', 'Session violates a schema constraint');
    }
    throw new SessionRepositoryError('CONSTRAINT', 'Session could not be created');
  }

  /**
   * Counts come back as BIGINT strings too, so they need the same conversion.
   * Reads the PINNED client, so the numbers reflect the in-flight transaction
   * rather than what another connection can see.
   */
  async function finalState(
    client: Queryable,
    sessionId: string,
    questionId: string,
    selectedOptionIds: readonly number[]
  ): Promise<SavedAnswerState> {
    const answered = await client.query<{ n: string }>(COUNT_ANSWERS, [sessionId]);
    const questions = await client.query<{ n: string }>(COUNT_QUESTIONS, [sessionId]);
    return {
      questionId,
      selectedOptionIds,
      // Derived from persisted rows — never from anything the client sent.
      answeredCount: num(answered.rows[0]?.n),
      questionCount: num(questions.rows[0]?.n)
    };
  }

  const repository: SessionRepository = {
    async createSessionSnapshot(input) {
      validateCreateInput(input);

      try {
        /**
         * ONE transaction covering the session row, every question and every
         * option. A failure anywhere — a constraint violation on the last
         * option included — leaves no session, no questions and no options.
         *
         * Every statement uses the PINNED client. Using `db` here would run
         * outside the transaction and survive a rollback.
         */
        await db.transaction(async (client) => {
          await client.query(INSERT_SESSION, [
            input.id,
            input.tokenHash,
            JSON.stringify(input.config),
            input.durationSeconds,
            input.createdAt,
            input.expiresAt,
            input.attemptId
          ]);

          for (const question of input.questions) {
            await client.query(INSERT_QUESTION, [
              input.id,
              question.position,
              question.questionId,
              question.sourceQuizId,
              question.questionText,
              question.type,
              question.explanation,
              question.codeSnippet?.code ?? null,
              question.codeSnippet?.language ?? null,
              question.codeSnippet?.filename ?? null
            ]);

            for (const option of question.options) {
              await client.query(INSERT_OPTION, [
                input.id,
                question.position,
                option.optionId,
                option.text,
                option.displayOrder,
                option.isCorrect ? 1 : 0
              ]);
            }
          }
        });
      } catch (err: unknown) {
        classifyWriteError(err);
      }

      const created = await this.getSessionById(input.id);
      if (!created) {
        throw new SessionRepositoryError('NOT_FOUND', 'Session vanished immediately after creation');
      }
      return created;
    },

    async getSessionById(sessionId) {
      const { rows } = await db.query<SessionRow>(SELECT_SESSION, [sessionId]);
      const row = rows[0];
      return row ? toRecord(row) : null;
    },

    async getSessionAuthenticationRecord(sessionId) {
      const { rows } = await db.query<{
        id: string; token_hash: string; status: string; expires_at: string;
      }>(SELECT_AUTH, [sessionId]);

      const row = rows[0];
      if (!row) return null;
      return {
        sessionId: row.id,
        tokenHash: row.token_hash,
        status: toStatus(row.status, row.id),
        expiresAt: num(row.expires_at)
      };
    },

    async markExpiredIfDue(sessionId, now) {
      // Single UPDATE guarded on both status and deadline, so two concurrent
      // requests cannot both believe they performed the transition.
      await db.query(EXPIRE_IF_DUE, [sessionId, now]);
      return this.getSessionById(sessionId);
    },

    async getSessionByAttemptId(attemptId) {
      const { rows } = await db.query<SessionRow>(SELECT_BY_ATTEMPT, [attemptId]);
      const row = rows[0];
      return row ? toRecord(row) : null;
    },

    async getSessionSnapshot(sessionId) {
      const session = await this.getSessionById(sessionId);
      if (!session) return null;

      const questionRows = await db.query<QuestionRow>(SELECT_QUESTIONS, [sessionId]);
      const optionRows = await db.query<OptionRow>(SELECT_OPTIONS, [sessionId]);

      return {
        session,
        questions: toQuestions(
          questionRows.rows,
          toOptions(optionRows.rows),
          `Session ${sessionId}`
        )
      };
    },

    async getAnswers(sessionId) {
      const { rows } = await db.query<AnswerRow>(SELECT_ANSWERS, [sessionId]);
      return rows.map((row) => ({
        position: num(row.question_position),
        selectedOptionIds: parseSelectedOptionIds(
          row.selected_option_ids,
          `Session ${sessionId} answer ${num(row.question_position)}`
        ),
        updatedAt: num(row.updated_at)
      }));
    },

    async markExpired(sessionId, expiredAt) {
      void expiredAt;   // recorded on submission (Stage 8), not on the status flip
      await db.query(EXPIRE_NOW, [sessionId]);
      const record = await this.getSessionById(sessionId);
      if (!record) {
        throw new SessionRepositoryError('NOT_FOUND', 'Session not found');
      }
      return record;
    },

    async deleteSession(sessionId) {
      const { rowCount } = await db.query(DELETE_SESSION, [sessionId]);
      return (rowCount ?? 0) > 0;
    },

    async saveAnswer(input) {
      try {
        return await db.transaction(async (client) => {
          const stateResult = await client.query<{
            id: string; status: string; expires_at: string;
          }>(SELECT_STATE_FOR_UPDATE, [input.sessionId]);
          const state = stateResult.rows[0];

          if (!state) {
            throw new SessionRepositoryError('SESSION_NOT_FOUND', 'Session not found');
          }
          if (state.status === 'submitted') {
            throw new SessionRepositoryError('SESSION_NOT_ACTIVE', 'Session already submitted');
          }
          if (state.status === 'expired') {
            throw new SessionRepositoryError('SESSION_EXPIRED', 'Session expired');
          }

          // BOUNDARY: now >= expiresAt is expired. A save exactly AT the
          // deadline fails, one millisecond before succeeds.
          //
          // The status flip deliberately does NOT happen here: throwing rolls
          // the transaction back, which would undo it. It is applied by the
          // caller after the rollback, so the rejected write vanishes while the
          // expiry sticks.
          if (input.now >= num(state.expires_at)) {
            throw new SessionRepositoryError('SESSION_EXPIRED', 'Session expired');
          }

          const questionResult = await client.query<{ position: number; question_type: string }>(
            SELECT_QUESTION_BY_PUBLIC_ID,
            [input.sessionId, input.questionId]
          );
          const question = questionResult.rows[0];

          if (!question) {
            // Covers both "no such question" and "belongs to another session" —
            // the lookup is scoped by session_id, so neither is distinguishable.
            throw new SessionRepositoryError(
              'QUESTION_NOT_IN_SESSION',
              'Question does not belong to this session'
            );
          }

          const position = num(question.position);
          const type = toQuestionType(question.question_type, `Session ${input.sessionId}`);
          const selected = [...input.selectedOptionIds];

          if (selected.length === 0) {
            await client.query(DELETE_ANSWER, [input.sessionId, position]);
            return finalState(client, input.sessionId, input.questionId, []);
          }

          // Single and trueFalse are both single-selection.
          if (type !== 'multiple' && selected.length !== 1) {
            throw new SessionRepositoryError(
              'INVALID_SELECTION_COUNT',
              'This question accepts exactly one selection'
            );
          }

          // Ownership is resolved from the FROZEN snapshot, scoped by session
          // AND question position — never from the numeric option-id formula,
          // which collides across questions by design.
          const ownedResult = await client.query<{ option_id: number }>(
            SELECT_OPTION_IDS_FOR_QUESTION,
            [input.sessionId, position]
          );
          const owned = new Set(ownedResult.rows.map((row) => num(row.option_id)));

          if (selected.length > owned.size) {
            throw new SessionRepositoryError(
              'INVALID_SELECTION_COUNT',
              'More selections than this question has options'
            );
          }
          for (const optionId of selected) {
            if (!owned.has(optionId)) {
              throw new SessionRepositoryError(
                'OPTION_NOT_IN_QUESTION',
                'Selected option does not belong to this question'
              );
            }
          }

          // Canonical ascending order: selection order carries no meaning
          // anywhere in the app, so sorting makes repeated saves
          // byte-identical and comparison trivial.
          const canonical = [...selected].sort((a, b) => a - b);

          await client.query(UPSERT_ANSWER, [
            input.sessionId,
            position,
            JSON.stringify(canonical),
            input.now
          ]);

          return finalState(client, input.sessionId, input.questionId, canonical);
        });
      } catch (err: unknown) {
        // The transaction has already rolled back, so the rejected answer left
        // no trace. Record the expiry now, OUTSIDE it, so the state change
        // survives. The UPDATE is guarded on status = 'active', making it safe
        // to run repeatedly and under concurrency.
        if (err instanceof SessionRepositoryError && err.category === 'SESSION_EXPIRED') {
          await db.query(EXPIRE_NOW, [input.sessionId]);
        }
        throw err;
      }
    },

    /**
     * Set or clear the Mark-for-Review flag for ONE question — never an
     * answer. Mirrors `saveAnswer`'s transaction shape (state check, boundary
     * expiry check, question lookup) but skips every selection/ownership
     * check, since a flag carries no selection.
     */
    async setFlagged(input) {
      try {
        return await db.transaction(async (client) => {
          const stateResult = await client.query<{
            id: string; status: string; expires_at: string;
          }>(SELECT_STATE_FOR_UPDATE, [input.sessionId]);
          const state = stateResult.rows[0];

          if (!state) {
            throw new SessionRepositoryError('SESSION_NOT_FOUND', 'Session not found');
          }
          if (state.status === 'submitted') {
            throw new SessionRepositoryError('SESSION_NOT_ACTIVE', 'Session already submitted');
          }
          if (state.status === 'expired') {
            throw new SessionRepositoryError('SESSION_EXPIRED', 'Session expired');
          }
          if (input.now >= num(state.expires_at)) {
            throw new SessionRepositoryError('SESSION_EXPIRED', 'Session expired');
          }

          const questionResult = await client.query<{ position: number }>(
            SELECT_QUESTION_BY_PUBLIC_ID,
            [input.sessionId, input.questionId]
          );
          const question = questionResult.rows[0];
          if (!question) {
            throw new SessionRepositoryError(
              'QUESTION_NOT_IN_SESSION',
              'Question does not belong to this session'
            );
          }

          const position = num(question.position);
          await client.query(UPDATE_FLAGGED, [input.flagged ? 1 : 0, input.sessionId, position]);

          return { questionId: input.questionId, flagged: input.flagged };
        });
      } catch (err: unknown) {
        if (err instanceof SessionRepositoryError && err.category === 'SESSION_EXPIRED') {
          await db.query(EXPIRE_NOW, [input.sessionId]);
        }
        throw err;
      }
    },

    async finalizeSession(input) {
      return db.transaction(async (client) => {
        const rowResult = await client.query<{
          id: string; status: string; config_json: string; duration_seconds: number;
          created_at: string; expires_at: string; result_json: string | null;
        }>(SELECT_FOR_FINALIZE, [input.sessionId]);
        const row = rowResult.rows[0];

        if (!row) throw new SessionRepositoryError('SESSION_NOT_FOUND', 'Session not found');

        // IDEMPOTENT: an already-submitted session returns its stored result and
        // is never rescored, so a manual submit racing an expiry submit yields
        // ONE result.
        if (row.status === 'submitted') {
          if (row.result_json === null) {
            throw new SessionRepositoryError('CORRUPT_DATA', 'Submitted session has no stored result');
          }
          return parseFrozenResult(JSON.parse(row.result_json), input.sessionId);
        }

        const config = parseConfig(row.config_json, row.id);
        const expiresAt = num(row.expires_at);
        const durationSeconds = num(row.duration_seconds);

        const questionRows = await client.query<QuestionRow>(SELECT_QUESTIONS, [input.sessionId]);
        const optionRows = await client.query<OptionRow>(SELECT_OPTIONS, [input.sessionId]);
        const answerRows = await client.query<AnswerRow>(SELECT_ANSWERS, [input.sessionId]);

        const questions = toQuestions(
          questionRows.rows,
          toOptions(optionRows.rows),
          `Session ${input.sessionId}`
        );

        const answersByPosition = new Map<number, readonly number[]>(
          answerRows.rows.map((answer) => [
            num(answer.question_position),
            parseSelectedOptionIds(
              answer.selected_option_ids,
              `Session ${input.sessionId} answer ${num(answer.question_position)}`
            )
          ])
        );

        const scored = scoreInterview({
          questions,
          answersByPosition,
          topicTitleFor: input.topicTitleFor
        });

        // A deadline that has already passed means the attempt ended by EXPIRY,
        // regardless of which call finalized it — including a session Stage 7
        // already flipped to 'expired'.
        const submittedByExpiry = input.now >= expiresAt || row.status === 'expired';
        const submittedAt = Math.min(input.now, expiresAt);

        const timing = computeTimeUsedSeconds({
          now: input.now,
          expiresAt,
          durationSeconds
        });

        const result: FrozenInterviewResult = {
          sessionId: row.id,
          status: 'submitted',
          submittedAt,
          submittedByExpiry,
          total: scored.total,
          answered: scored.answered,
          unanswered: scored.unanswered,
          correct: scored.correct,
          incorrect: scored.incorrect,
          percentage: scored.percentage,
          durationSeconds,
          timeUsedSeconds: timing.timeUsedSeconds,
          timeRemainingSeconds: timing.timeRemainingSeconds,
          config: {
            mode: config.presetId ? 'preset' : 'custom',
            ...(config.presetId ? { presetId: config.presetId } : { difficulty: config.difficulty }),
            topicIds: [...config.topicIds],
            questionCount: config.questionCount
          },
          performance: { byTopic: scored.byTopic },
          review: scored.review
        };

        // Validate BEFORE writing: a result that fails its invariants must never
        // become durable.
        assertResultInvariants(result);

        const written = await client.query(WRITE_RESULT, [
          submittedAt,
          submittedByExpiry ? 1 : 0,
          JSON.stringify(result),
          input.sessionId
        ]);

        if ((written.rowCount ?? 0) === 0) {
          // Someone else submitted between our read and our write — return theirs.
          const winner = await client.query<{ result_json: string | null }>(
            SELECT_RESULT,
            [input.sessionId]
          );
          const stored = winner.rows[0]?.result_json;
          if (!stored) {
            throw new SessionRepositoryError('CORRUPT_DATA', 'Concurrent finalization left no result');
          }
          return parseFrozenResult(JSON.parse(stored), input.sessionId);
        }

        return result;
      });
    },

    async getSubmittedResult(sessionId) {
      const { rows } = await db.query<{ status: string; result_json: string | null }>(
        SELECT_RESULT,
        [sessionId]
      );
      const row = rows[0];
      if (!row || row.status !== 'submitted' || row.result_json === null) return null;

      let parsed: unknown;
      try {
        parsed = JSON.parse(row.result_json);
      } catch {
        throw new SessionRepositoryError('CORRUPT_DATA', `Session ${sessionId} has an unreadable result`);
      }
      // Revalidated on every read — never regenerated.
      return parseFrozenResult(parsed, sessionId);
    }
  };

  return repository;
}
