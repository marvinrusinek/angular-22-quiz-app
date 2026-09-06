import type { QuizRepository } from '../quiz/quiz.repository';
import type { SessionRepository, SavedAnswerState, FlaggedState } from './session.repository';
import { SessionRepositoryError } from './session.repository';
import { buildInterviewAssessment, validateBuildRequest } from './assessment.builder';
import { buildPresetAssessment } from './assessment.preset-builder';
import { findInterviewPreset } from './interview-presets';
import { cryptoRandomSource, type RandomSource } from './assessment.random';
import { generateSessionIdentity, tokenMatches } from './session.token';
import {
  toActiveSessionDto,
  toInterviewResultDto,
  type ActiveInterviewAnswerDto,
  type ActiveInterviewSessionDto,
  type InterviewResultDto
} from './session.dto';
import { AssessmentBuildError, type GeneratedInterviewSnapshot } from './assessment.types';
import type { CreateSessionInput } from './session.types';

/**
 * Interview session orchestration. Knows nothing about Express — it takes
 * plain values and returns plain values, so the route stays a thin adapter.
 */

export type SessionServiceErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'SESSION_EXPIRED'
  | 'CONFLICT'
  | 'INTERNAL';

export class SessionServiceError extends Error {
  public override readonly name = 'SessionServiceError';
  public readonly code: SessionServiceErrorCode;

  constructor(code: SessionServiceErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Identical response for every authentication failure — see resumeSession. */
function unauthorized(): SessionServiceError {
  return new SessionServiceError('UNAUTHORIZED', 'Invalid session credentials');
}

/**
 * A submit body must be empty. Every value in a result is determined by the
 * server, so a client claim about the score, the reason, the timestamps or the
 * answers is rejected rather than ignored.
 */
function assertEmptySubmitBody(body: unknown): void {
  if (body === undefined || body === null) return;
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new SessionServiceError('BAD_REQUEST', 'Submit body must be empty');
  }
  const keys = Object.keys(body);
  if (keys.length > 0) {
    throw new SessionServiceError(
      'BAD_REQUEST',
      `Submit accepts no fields — "${keys[0]}" is determined by the server`
    );
  }
}

const MAX_SELECTED_OPTIONS = 32;

/**
 * Strict body validation for a save. Nothing is coerced: `"401"` is a string,
 * not an option id, and is rejected rather than parsed.
 */
function parseSelectedOptionIds(body: unknown): readonly number[] {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new SessionServiceError('BAD_REQUEST', 'Request body must be an object');
  }

  for (const key of Object.keys(body)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new SessionServiceError('BAD_REQUEST', 'Request contains a forbidden key');
    }
    if (key !== 'selectedOptionIds') {
      // Catches correctness/score/explanation/questionId/optionText claims and
      // anything else a client might invent.
      throw new SessionServiceError('BAD_REQUEST', `Unexpected field "${key}"`);
    }
  }

  const raw = (body as { selectedOptionIds?: unknown }).selectedOptionIds;
  if (!Array.isArray(raw)) {
    throw new SessionServiceError('BAD_REQUEST', 'selectedOptionIds must be an array');
  }
  if (raw.length > MAX_SELECTED_OPTIONS) {
    throw new SessionServiceError('BAD_REQUEST', 'Too many selected options');
  }

  const seen = new Set<number>();
  for (const value of raw) {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new SessionServiceError('BAD_REQUEST', 'selectedOptionIds must contain integers');
    }
    if (seen.has(value)) {
      throw new SessionServiceError('BAD_REQUEST', 'selectedOptionIds contains duplicates');
    }
    seen.add(value);
  }

  return raw as readonly number[];
}

/**
 * Strict body validation for a review-flag write. Accepts ONLY
 * `{ flagged: boolean }` — no selection, no question metadata, nothing that
 * could be mistaken for an answer.
 */
function parseFlagged(body: unknown): boolean {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new SessionServiceError('BAD_REQUEST', 'Request body must be an object');
  }

  for (const key of Object.keys(body)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new SessionServiceError('BAD_REQUEST', 'Request contains a forbidden key');
    }
    if (key !== 'flagged') {
      throw new SessionServiceError('BAD_REQUEST', `Unexpected field "${key}"`);
    }
  }

  const flagged = (body as { flagged?: unknown }).flagged;
  if (typeof flagged !== 'boolean') {
    throw new SessionServiceError('BAD_REQUEST', 'flagged must be a boolean');
  }
  return flagged;
}

/** Map repository categories onto service errors, revealing nothing extra. */
function translateRepositoryError(err: unknown): unknown {
  if (!(err instanceof SessionRepositoryError)) return err;

  switch (err.category) {
    case 'SESSION_NOT_FOUND':
      // Already authenticated, so this can only be a race with deletion.
      return unauthorized();
    case 'SESSION_EXPIRED':
      return new SessionServiceError('SESSION_EXPIRED', 'This assessment has expired');
    case 'SESSION_NOT_ACTIVE':
      return new SessionServiceError('CONFLICT', 'This assessment has already been submitted');
    case 'QUESTION_NOT_IN_SESSION':
      return new SessionServiceError('BAD_REQUEST', 'Question does not belong to this session');
    case 'OPTION_NOT_IN_QUESTION':
      return new SessionServiceError('BAD_REQUEST', 'Selected option does not belong to this question');
    case 'INVALID_SELECTION_COUNT':
      return new SessionServiceError('BAD_REQUEST', err.message);
    default:
      return new SessionServiceError('INTERNAL', 'Answer could not be saved');
  }
}

export interface CreateSessionRequest {
  readonly mode?: unknown;
  readonly presetId?: unknown;
  readonly difficulty?: unknown;
  readonly topicIds?: unknown;
  readonly questionCount?: unknown;
}

/** Fields a client may never dictate; presence is a hard rejection. */
const FORBIDDEN_REQUEST_KEYS = [
  'durationSeconds', 'duration', 'expiresAt', 'createdAt', 'sessionId', 'attemptId',
  'sessionToken', 'tokenHash', 'questionIds', 'optionIds', 'questions', 'options',
  'correct', 'isCorrect', 'correctOptionIds', 'score', 'result', 'status'
];

const ALLOWED_REQUEST_KEYS = ['mode', 'presetId', 'difficulty', 'topicIds', 'questionCount'];

const MAX_TOPIC_IDS = 50;
const MAX_STRING_LENGTH = 100;

export interface SessionServiceDeps {
  readonly quizRepository: QuizRepository;
  readonly sessionRepository: SessionRepository;
  readonly now: () => number;
  /** Question/option shuffling ONLY. Never used for tokens or ids. */
  readonly random?: RandomSource;
}

export class InterviewSessionService {
  private readonly quizRepository: QuizRepository;
  private readonly sessionRepository: SessionRepository;
  private readonly now: () => number;
  private readonly random: RandomSource;

  constructor(deps: SessionServiceDeps) {
    this.quizRepository = deps.quizRepository;
    this.sessionRepository = deps.sessionRepository;
    this.now = deps.now;
    this.random = deps.random ?? cryptoRandomSource;
  }

  async createSession(request: CreateSessionRequest): Promise<ActiveInterviewSessionDto> {
    const snapshot = this.resolveAssessment(this.validateRequest(request));
    const createdAt = this.now();
    const expiresAt = createdAt + snapshot.durationSeconds * 1000;

    const session = await this.persistWithIdentityRetry(snapshot, createdAt, expiresAt);

    const stored = await this.sessionRepository.getSessionSnapshot(session.sessionId);
    if (!stored) throw new SessionServiceError('INTERNAL', 'Session could not be read back');

    return toActiveSessionDto({
      session: stored.session,
      questions: stored.questions,
      answers: [],                       // Stage 7 fills this from persistence.
      now: createdAt,
      sessionToken: session.rawToken     // the ONE place the raw token is returned
    });
  }

  /**
   * Save or clear ONE question's selection.
   *
   * Authentication happens FIRST — no question or option validation runs until
   * the bearer token matches, so the endpoint cannot be used to probe which
   * question ids exist in a session the caller does not own.
   */
  async saveAnswer(
    sessionId: string,
    questionId: string,
    rawToken: string | null,
    body: unknown
  ): Promise<SavedAnswerState> {
    await this.authenticate(sessionId, rawToken);

    const selectedOptionIds = parseSelectedOptionIds(body);

    try {
      // One transaction: state, expiry, membership and the write. `now` is
      // captured once, inside this call, so the deadline cannot move.
      return await this.sessionRepository.saveAnswer({
        sessionId,
        questionId,
        selectedOptionIds,
        now: this.now()
      });
    } catch (err: unknown) {
      throw translateRepositoryError(err);
    }
  }

  /**
   * Set or clear the Mark-for-Review flag for ONE question.
   *
   * Never touches an answer, never affects scoring or navigation, and never
   * reveals correctness — the response is `{ questionId, flagged }` only.
   */
  async setFlagged(
    sessionId: string,
    questionId: string,
    rawToken: string | null,
    body: unknown
  ): Promise<FlaggedState> {
    await this.authenticate(sessionId, rawToken);

    const flagged = parseFlagged(body);

    try {
      return await this.sessionRepository.setFlagged({
        sessionId,
        questionId,
        flagged,
        now: this.now()
      });
    } catch (err: unknown) {
      throw translateRepositoryError(err);
    }
  }

  /**
   * Finalize the assessment. Idempotent: an already-submitted session returns
   * its frozen result untouched, so a manual submit racing an expiry submit
   * produces exactly ONE result.
   *
   * Works for active AND already-expired sessions — the client is never
   * required to have submitted at the exact moment the countdown hit zero.
   */
  async submitSession(sessionId: string, rawToken: string | null, body: unknown): Promise<InterviewResultDto> {
    await this.authenticate(sessionId, rawToken);
    assertEmptySubmitBody(body);

    try {
      const result = await this.sessionRepository.finalizeSession({
        sessionId,
        now: this.now(),
        topicTitleFor: (topicId) => this.topicTitle(topicId)
      });
      return toInterviewResultDto(result);
    } catch (err: unknown) {
      throw translateRepositoryError(err);
    }
  }

  /**
   * The frozen result.
   *
   * DECISION: an expired-but-unfinalized session is FINALIZED here rather than
   * being told to POST /submit first. A user whose tab was closed at the
   * deadline would otherwise be stuck with a result they can never retrieve.
   * The transition is idempotent and produces the same frozen result the submit
   * route would.
   */
  async getResult(sessionId: string, rawToken: string | null): Promise<InterviewResultDto> {
    await this.authenticate(sessionId, rawToken);

    const auth = await this.sessionRepository.getSessionAuthenticationRecord(sessionId);
    if (!auth) throw unauthorized();

    const now = this.now();

    if (auth.status === 'submitted') {
      const stored = await this.sessionRepository.getSubmittedResult(sessionId);
      if (!stored) throw new SessionServiceError('INTERNAL', 'Result could not be read');
      return toInterviewResultDto(stored);
    }

    const deadlinePassed = auth.status === 'expired' || auth.expiresAt <= now;
    if (!deadlinePassed) {
      // Still running — a result does not exist yet.
      throw new SessionServiceError('CONFLICT', 'This assessment has not been submitted');
    }

    try {
      const result = await this.sessionRepository.finalizeSession({
        sessionId,
        now,
        topicTitleFor: (topicId) => this.topicTitle(topicId)
      });
      return toInterviewResultDto(result);
    } catch (err: unknown) {
      throw translateRepositoryError(err);
    }
  }

  /** Topic display title, frozen into the result at finalization. */
  private topicTitle(topicId: string): string {
    return this.quizRepository.getQuizById(topicId)?.milestone ?? topicId;
  }

  async resumeSession(sessionId: string, rawToken: string | null): Promise<ActiveInterviewSessionDto> {
    // A single generic failure for missing/malformed/unknown/mismatched, so the
    // response cannot be used to probe which session ids exist.
    await this.authenticate(sessionId, rawToken);

    const auth = await this.sessionRepository.getSessionAuthenticationRecord(sessionId);
    if (!auth) throw unauthorized();

    const now = this.now();

    // Never trust a stored 'active' without checking the deadline.
    if (auth.status === 'active' && auth.expiresAt <= now) {
      await this.sessionRepository.markExpiredIfDue(sessionId, now);
      throw new SessionServiceError('SESSION_EXPIRED', 'This assessment has expired');
    }
    if (auth.status === 'expired') {
      throw new SessionServiceError('SESSION_EXPIRED', 'This assessment has expired');
    }
    if (auth.status === 'submitted') {
      // Results arrive in Stage 8; the active route never serves a finished one.
      throw new SessionServiceError('CONFLICT', 'This assessment has already been submitted');
    }

    const stored = await this.sessionRepository.getSessionSnapshot(sessionId);
    if (!stored) throw unauthorized();

    return toActiveSessionDto({
      session: stored.session,
      questions: stored.questions,
      answers: await this.savedAnswers(sessionId, stored.questions),
      now
    });
  }

  /**
   * Persisted selections, keyed back to the OPAQUE questionId and ordered by
   * question position. A cleared answer has no row, so it simply does not
   * appear — the client's own model treats "no entry" as unanswered.
   */
  private async savedAnswers(
    sessionId: string,
    questions: readonly { position: number; questionId: string }[]
  ): Promise<ActiveInterviewAnswerDto[]> {
    const questionIdByPosition = new Map(questions.map((q) => [q.position, q.questionId]));

    const answers = await this.sessionRepository.getAnswers(sessionId);
    return answers
      .filter((answer) => answer.selectedOptionIds.length > 0)
      .sort((a, b) => a.position - b.position)
      .flatMap((answer) => {
        const questionId = questionIdByPosition.get(answer.position);
        if (!questionId) return [];   // defensive: orphan rows cannot exist
        return [{ questionId, selectedOptionIds: [...answer.selectedOptionIds] }];
      });
  }

  // ── internals ─────────────────────────────────────────────────────

  /** Verify the bearer token. Throws the SAME generic error for every failure. */
  private async authenticate(sessionId: string, rawToken: string | null): Promise<void> {
    if (!rawToken) throw unauthorized();
    const auth = await this.sessionRepository.getSessionAuthenticationRecord(sessionId);
    if (!auth) throw unauthorized();
    if (!tokenMatches(rawToken, auth.tokenHash)) throw unauthorized();
  }

  private validateRequest(request: CreateSessionRequest): CreateSessionRequest {
    if (request === null || typeof request !== 'object' || Array.isArray(request)) {
      throw new SessionServiceError('BAD_REQUEST', 'Request body must be an object');
    }

    for (const key of Object.keys(request)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw new SessionServiceError('BAD_REQUEST', 'Request contains a forbidden key');
      }
      if (FORBIDDEN_REQUEST_KEYS.includes(key)) {
        throw new SessionServiceError(
          'BAD_REQUEST',
          `"${key}" is determined by the server and may not be supplied`
        );
      }
      if (!ALLOWED_REQUEST_KEYS.includes(key)) {
        throw new SessionServiceError('BAD_REQUEST', `Unexpected field "${key}"`);
      }
    }

    if (Array.isArray(request.topicIds)) {
      if (request.topicIds.length > MAX_TOPIC_IDS) {
        throw new SessionServiceError('BAD_REQUEST', 'Too many topics requested');
      }
      for (const id of request.topicIds) {
        if (typeof id === 'string' && id.length > MAX_STRING_LENGTH) {
          throw new SessionServiceError('BAD_REQUEST', 'Topic id is too long');
        }
      }
    }

    return request;
  }

  private resolveAssessment(request: CreateSessionRequest): GeneratedInterviewSnapshot {
    const mode = request.mode;
    if (mode !== 'preset' && mode !== 'custom') {
      throw new SessionServiceError('BAD_REQUEST', 'mode must be "preset" or "custom"');
    }

    try {
      if (mode === 'preset') return this.buildPreset(request);
      return this.buildCustom(request);
    } catch (err: unknown) {
      if (err instanceof AssessmentBuildError) {
        throw new SessionServiceError('BAD_REQUEST', err.message);
      }
      throw err;
    }
  }

  private buildPreset(request: CreateSessionRequest): GeneratedInterviewSnapshot {
    if (typeof request.presetId !== 'string') {
      throw new SessionServiceError('BAD_REQUEST', 'presetId is required for preset mode');
    }
    // A preset owns its topics, count, duration and quotas. Accepting any of
    // them from the client would let a caller reshape the preset.
    for (const key of ['topicIds', 'difficulty', 'questionCount'] as const) {
      if (request[key] !== undefined) {
        throw new SessionServiceError(
          'BAD_REQUEST',
          `"${key}" may not be supplied with a preset — the preset defines it`
        );
      }
    }

    const preset = findInterviewPreset(request.presetId);
    if (!preset) {
      throw new SessionServiceError('BAD_REQUEST', `unknown preset "${request.presetId}"`);
    }

    return buildPresetAssessment(preset, this.quizRepository, this.random);
  }

  private buildCustom(request: CreateSessionRequest): GeneratedInterviewSnapshot {
    if (request.presetId !== undefined) {
      throw new SessionServiceError('BAD_REQUEST', 'presetId may not be supplied in custom mode');
    }
    const config = validateBuildRequest(
      {
        difficulty: request.difficulty,
        topicIds: request.topicIds,
        questionCount: request.questionCount
      },
      this.quizRepository
    );
    return buildInterviewAssessment(config, this.quizRepository, this.random);
  }

  /**
   * Persist the frozen snapshot. A session/attempt id collision is
   * astronomically unlikely with 128 bits, but if one occurred the correct
   * response is a fresh identity — NOT retrying a validation or integrity
   * failure, which would just fail again.
   */
  private async persistWithIdentityRetry(
    snapshot: GeneratedInterviewSnapshot,
    createdAt: number,
    expiresAt: number
  ): Promise<{ sessionId: string; rawToken: string }> {
    const MAX_ATTEMPTS = 3;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const identity = generateSessionIdentity();
      const input = this.toCreateInput(snapshot, identity, createdAt, expiresAt);

      try {
        await this.sessionRepository.createSessionSnapshot(input);
        return { sessionId: identity.sessionId, rawToken: identity.rawToken };
      } catch (err: unknown) {
        const collided =
          err instanceof SessionRepositoryError &&
          err.category === 'CONSTRAINT' &&
          /uniqueness/i.test(err.message);

        if (!collided || attempt === MAX_ATTEMPTS) {
          throw new SessionServiceError('INTERNAL', 'Session could not be created');
        }
        // else: mint a completely new identity and try again
      }
    }

    throw new SessionServiceError('INTERNAL', 'Session could not be created');
  }

  private toCreateInput(
    snapshot: GeneratedInterviewSnapshot,
    identity: { sessionId: string; attemptId: string; tokenHash: string },
    createdAt: number,
    expiresAt: number
  ): CreateSessionInput {
    return {
      id: identity.sessionId,
      tokenHash: identity.tokenHash,
      attemptId: identity.attemptId,
      config: {
        difficulty: snapshot.config.difficulty,
        topicIds: snapshot.config.topicIds,
        questionCount: snapshot.config.questionCount,
        ...(snapshot.config.presetId ? { presetId: snapshot.config.presetId } : {}),
        ...(snapshot.config.presetName ? { presetName: snapshot.config.presetName } : {})
      },
      durationSeconds: snapshot.durationSeconds,
      createdAt,
      expiresAt,
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
      }))
    };
  }
}
