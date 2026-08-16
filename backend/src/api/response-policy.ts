/**
 * Response classification + the recursive key guard.
 *
 * This is DEFENCE IN DEPTH, not the primary control. The primary control is
 * that mappers construct allow-listed literals (quiz.dto.ts). The guard exists
 * to catch the case where someone later returns a private model directly, or
 * widens a mapper without noticing.
 *
 * It inspects PROPERTY NAMES ONLY — never string values. A question legitimately
 * reading "Which answer is correct?" must pass; a property literally named
 * `correct` must not.
 */

export type ResponsePolicyName =
  | 'PUBLIC_METADATA'
  | 'QUIZ_QUESTIONS'
  | 'ATTEMPT_ISSUED'
  | 'ANSWER_REVEAL'
  | 'ACTIVE_ASSESSMENT'
  | 'SESSION_CREATED'
  | 'SUBMITTED_REVIEW'
  | 'ERROR';

/**
 * Normalize a property name so naming-convention drift cannot slip past:
 * `is_correct`, `isCorrect`, `IsCorrect` and `is-correct` all collapse to
 * `iscorrect`. Comparison is then exact against the banned set — deliberately
 * NOT a substring match, so `correctOptionIds` stays distinct from `correct`
 * and can be allowed independently.
 */
export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_\-\s]/g, '');
}

function banned(...keys: string[]): ReadonlySet<string> {
  return new Set(keys.map(normalizeKey));
}

/** Answer-key material — never legal outside an authorized review response. */
const ANSWER_KEY_FIELDS = [
  'correct',
  'isCorrect',
  'is_correct',
  'correctOptionIds',
  'correct_option_ids',
  'answerKey',
  'answer_key',
  'expectedAnswers',
  'expected_answers',
  'correctAnswers',
  'correct_answers'
];

/** Backend internals that must never be serialized under ANY policy. */
const INTERNAL_FIELDS = [
  'sourceQuestionIndex',
  'source_question_index',
  'sourceOptionIndex',
  'source_option_index',
  'tokenHash',
  'token_hash',
  'sessionToken',
  'session_token',
  'dataPath',
  'data_path',
  'databasePath',
  'database_path',
  'quizDataPath',
  'allowedOrigins',
  // Internal attempt identity. The client is given `sessionId`; `attemptId` is
  // the row-level key the scoring tables join on and must not leave the server.
  'attemptId',
  'attempt_id',
  // Raw SQLite column names. These would each be a whole serialized record —
  // `result_json` in particular is the complete frozen answer key. Banning the
  // column names means a `SELECT *` row handed to res.json fails loudly instead
  // of shipping storage internals.
  'result_json',
  'resultJson',
  'config_json',
  'configJson',
  'questions_json',
  'questionsJson',
  'answers_json',
  'answersJson'
  // NOT listed: `selected_option_ids`. normalizeKey() collapses separators, so
  // it is indistinguishable from `selectedOptionIds` — a field the save and
  // review DTOs legitimately return. Banning it would reject every valid
  // response. The column is kept out of responses by the mappers, which build
  // allow-listed literals and never spread a database row.
];

/**
 * Every form of question/option IDENTITY.
 *
 * The Topic Quiz contract addresses a question by its exact TEXT within a quiz,
 * and nothing else. Public identifiers were removed deliberately, so any of
 * these appearing on the wire is a contract regression:
 *
 *   - `questionId` / `optionId` — the legacy positional scheme, retained in the
 *     database only as `legacy_*` provenance
 *   - `id` — a PostgreSQL surrogate key, an internal implementation detail
 *   - `*Index` / `displayOrder` / `sourceIndex` — positional identity by
 *     another name; ordering is expressed ONLY by array position
 *   - `*Key` — the normalized lookup columns, which are internal
 *
 * `quizId` is deliberately NOT here: it is the one public identifier, and
 * normalizeKey keeps it distinct from `id` because matching is exact rather
 * than substring-based.
 */
const IDENTIFIER_FIELDS = [
  'questionId',
  'question_id',
  'optionId',
  'option_id',
  'id',
  'questionIndex',
  'question_index',
  'optionIndex',
  'option_index',
  'legacyQuestionId',
  'legacy_question_id',
  'legacyOptionId',
  'legacy_option_id',
  'displayOrder',
  'display_order',
  'sourceIndex',
  'source_index',
  'questionKey',
  'question_key',
  'optionKey',
  'option_key',
  'quizPk',
  'quiz_pk',
  'questionPk',
  'question_pk'
];

const POLICIES: Record<ResponsePolicyName, ReadonlySet<string>> = {
  /**
   * Metadata listings. Also bans `questions`/`options` so a metadata route can
   * never grow into a full question dump by accident.
   */
  PUBLIC_METADATA: banned(...ANSWER_KEY_FIELDS, ...INTERNAL_FIELDS, 'explanation', 'questions', 'options'),

  /**
   * Topic Quiz question delivery — the pre-answer payload.
   *
   * The STRICTEST policy in this module, and deliberately its own rather than a
   * reuse of ACTIVE_ASSESSMENT: that policy permits `questionId` and `optionId`
   * because Interview Mode's shipped contract needs them. Reusing it here would
   * silently allow identifiers back into a contract defined to have none.
   *
   * Bans identity, correctness, explanations and backend internals. Allows only
   * `quizId`, `questions`, `questionText`, `type`, `difficulty`, `correctCount`,
   * `options` and `text`.
   *
   * `correctCount` is CARDINALITY, not identity, and is permitted deliberately:
   * the UI has always shown "(N answers are correct)" before the user answers,
   * so the number is on screen either way — this only changes where it comes
   * from. It normalizes to `correctcount`, which is distinct from the banned
   * `correctAnswers`/`correctOptionIds`, and it is the same line
   * `remainingCorrectCount` already draws on the check response.
   */
  QUIZ_QUESTIONS: banned(
    ...ANSWER_KEY_FIELDS,
    ...INTERNAL_FIELDS,
    ...IDENTIFIER_FIELDS,
    'explanation',
    'facts'
  ),

  /**
   * The attempt-creation response: `{ quizId, durationSeconds, startedAt,
   * expiresAt, attemptReceipt }`.
   *
   * The receipt itself is a signed, readable payload of timing metadata, so it
   * is not answer-key material — but nothing else may ride along. Correctness,
   * explanations, identifiers, the signing key and any signature internals are
   * all banned.
   */
  ATTEMPT_ISSUED: banned(
    ...ANSWER_KEY_FIELDS,
    ...INTERNAL_FIELDS,
    ...IDENTIFIER_FIELDS,
    'explanation',
    'questions',
    'options',
    // The signing key and anything that would expose the signature scheme.
    'secret',
    'receiptSecret',
    'receipt_secret',
    'topicQuizReceiptSecret',
    'signingKey',
    'signing_key',
    'signature',
    'hmac',
    'payload'
  ),

  /**
   * The per-question reveal — the ONLY policy outside submitted review that may
   * carry correctness or an explanation.
   *
   * A TIGHTLY SCOPED widening. `correct`, `correctOptionTexts` and
   * `explanation` become legal because that IS the response; everything that
   * would turn one question's reveal into a bulk leak stays banned:
   * identifiers, per-option `isCorrect` flags, `questions`/`options` arrays
   * (which would imply data for more than the one question asked about), the
   * signing key and every backend internal.
   */
  ANSWER_REVEAL: banned(
    // Per-option boolean correctness stays banned. The incomplete response
    // expresses verdicts as `selectedVerdicts[].correct`, scoped to the user's
    // own picks — never `isCorrect` on an option object.
    'isCorrect',
    'is_correct',
    'answerKey',
    'answer_key',
    'expectedAnswers',
    'expected_answers',
    'correctAnswers',
    'correct_answers',
    'correctOptionIds',
    'correct_option_ids',
    ...INTERNAL_FIELDS,
    ...IDENTIFIER_FIELDS,
    // Bulk shapes. A reveal is for ONE question; these keys would mean the
    // response had grown to carry a collection.
    'questions',
    'options',
    'quizzes',
    'secret',
    'receiptSecret',
    'receipt_secret',
    'topicQuizReceiptSecret',
    'signingKey',
    'signing_key',
    'hmac'
    // NOT banned: `correct`, `correctOptionTexts`, `explanation`,
    // `selectedVerdicts`, `remainingCorrectCount` — the authorized payload.
  ),

  /**
   * Live assessment. Options ARE allowed; correctness, FET and the session
   * token are not — a resume response must never repeat the token.
   */
  ACTIVE_ASSESSMENT: banned(...ANSWER_KEY_FIELDS, ...INTERNAL_FIELDS, 'explanation'),

  /**
   * The session-CREATION response, and the only place a raw `sessionToken` may
   * appear. Identical to ACTIVE_ASSESSMENT in every other respect — the token
   * is exempted for this ONE route rather than removed from the global banned
   * set, so resume, review and metadata all keep rejecting it.
   */
  SESSION_CREATED: banned(
    ...ANSWER_KEY_FIELDS,
    ...INTERNAL_FIELDS.filter((field) => normalizeKey(field) !== normalizeKey('sessionToken')),
    'explanation'
  ),

  /**
   * Post-submission review. A TIGHTLY SCOPED widening, not "anything goes":
   * `correctOptionIds` and `explanation` become legal, while raw per-option
   * correctness (`correct`, `isCorrect`, `is_correct`) and every backend
   * internal stay banned. Review DTOs express correctness as an explicit id
   * list, so the raw flags are never needed.
   */
  SUBMITTED_REVIEW: banned(
    // PER-OPTION correctness stays banned: an option must never carry a boolean
    // answer flag. Correctness is expressed ONLY as `correctOptionIds`.
    'isCorrect',
    'is_correct',
    'answerKey',
    'answer_key',
    'expectedAnswers',
    'expected_answers',
    ...INTERNAL_FIELDS
    // NOTE: bare `correct` is deliberately NOT banned here. In a submitted
    // result it is the AGGREGATE COUNT of correct answers (matching Angular's
    // InterviewResult.correct), not an answer flag — earned data the user is
    // entitled to see. It remains banned under PUBLIC_METADATA and
    // ACTIVE_ASSESSMENT, where any `correct` key would be a genuine leak.
  ),

  /** Error envelopes are `{ error: { code, message } }` — internals still banned. */
  ERROR: banned(...ANSWER_KEY_FIELDS, ...INTERNAL_FIELDS)
};

export interface PolicyViolation {
  /** Dotted path to the offending property, e.g. `quizzes[0].options[1]`. */
  readonly path: string;
  /** The offending property NAME. Never its value. */
  readonly key: string;
  readonly policy: ResponsePolicyName;
}

/**
 * Walk a JSON-compatible body and return the first banned property name found.
 *
 * Recurses through nested objects, arrays, objects inside arrays and arrays
 * inside arrays. Cycles are tracked so a self-referencing body cannot hang the
 * request. Values are never inspected or copied.
 */
export function findPolicyViolation(
  body: unknown,
  policy: ResponsePolicyName
): PolicyViolation | null {
  const bannedKeys = POLICIES[policy];
  const seen = new WeakSet<object>();

  function walk(value: unknown, path: string): PolicyViolation | null {
    if (value === null || typeof value !== 'object') return null;
    if (seen.has(value)) return null;
    seen.add(value);

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const found = walk(value[i], `${path}[${i}]`);
        if (found) return found;
      }
      return null;
    }

    for (const key of Object.keys(value)) {
      if (bannedKeys.has(normalizeKey(key))) {
        return { path: path === '' ? key : `${path}.${key}`, key, policy };
      }
      const found = walk((value as Record<string, unknown>)[key], path === '' ? key : `${path}.${key}`);
      if (found) return found;
    }
    return null;
  }

  return walk(body, '');
}

export function isKeyBanned(key: string, policy: ResponsePolicyName): boolean {
  return POLICIES[policy].has(normalizeKey(key));
}
