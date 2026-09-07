package com.quizbackend.security.responsepolicy;

import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Set;

/**
 * Response classification + the per-policy banned-property-name sets.
 *
 * <p>This is a line-for-line port of the Node/Express reference backend's
 * {@code backend/src/api/response-policy.ts}. It is DEFENCE IN DEPTH, not the
 * primary control &mdash; the primary control is that DTOs are built as
 * explicit, allow-listed literals. This exists to catch the case where a
 * future controller returns an entity, a raw {@code Map}, or a widened DTO
 * without anyone noticing.
 *
 * <p>It inspects PROPERTY NAMES ONLY, never values. A question legitimately
 * reading "Which answer is correct?" must pass; a property literally named
 * {@code correct} must not.
 */
public enum ResponsePolicy {

    /** Metadata listings. Also bans {@code questions}/{@code options} so a metadata route can never grow into a full question dump by accident. */
    PUBLIC_METADATA(Fields.ANSWER_KEY, Fields.INTERNAL, Set.of("explanation", "questions", "options")),

    /**
     * Topic Quiz question delivery &mdash; the pre-answer payload. The strictest
     * policy: bans identity, correctness, explanations and internals. Allows
     * only quizId, questions, questionText, type, difficulty, correctCount,
     * options, text. {@code correctCount} is cardinality, not identity, and is
     * permitted deliberately (it normalizes distinct from the banned
     * correctAnswers/correctOptionIds).
     */
    QUIZ_QUESTIONS(Fields.ANSWER_KEY, Fields.INTERNAL, Fields.IDENTIFIER, Set.of("explanation", "facts")),

    /** The attempt-creation response. The receipt itself is signed, readable timing metadata &mdash; not answer-key material &mdash; but nothing else may ride along. */
    ATTEMPT_ISSUED(Fields.ANSWER_KEY, Fields.INTERNAL, Fields.IDENTIFIER, Set.of(
            "explanation", "questions", "options",
            "secret", "receiptSecret", "receipt_secret", "topicQuizReceiptSecret",
            "signingKey", "signing_key", "signature", "hmac", "payload"
    )),

    /**
     * The per-question reveal &mdash; the ONLY policy outside submitted review that
     * may carry correctness or an explanation. A tightly scoped widening:
     * {@code correct}, {@code correctOptionTexts} and {@code explanation} become
     * legal; everything that would turn a one-question reveal into a bulk leak
     * stays banned (identifiers, per-option isCorrect, questions/options/quizzes
     * arrays, signing internals).
     */
    ANSWER_REVEAL(
            Set.of("isCorrect", "is_correct", "answerKey", "answer_key",
                    "expectedAnswers", "expected_answers", "correctAnswers", "correct_answers",
                    "correctOptionIds", "correct_option_ids"),
            Fields.INTERNAL, Fields.IDENTIFIER,
            Set.of("questions", "options", "quizzes",
                    "secret", "receiptSecret", "receipt_secret", "topicQuizReceiptSecret",
                    "signingKey", "signing_key", "hmac")
    ),

    /** Live assessment. Options ARE allowed; correctness, FET and the session token are not &mdash; a resume response must never repeat the token. */
    ACTIVE_ASSESSMENT(Fields.ANSWER_KEY, Fields.INTERNAL, Set.of("explanation")),

    /**
     * The session-CREATION response, and the only place a raw session token may
     * appear. Identical to ACTIVE_ASSESSMENT except the token is exempted for
     * this ONE policy rather than removed from the global banned set.
     */
    SESSION_CREATED(Fields.ANSWER_KEY, Fields.internalWithoutSessionToken(), Set.of("explanation")),

    /**
     * Post-submission review. A tightly scoped widening: correctOptionIds and
     * explanation become legal; raw per-option correctness and every backend
     * internal stay banned. Bare {@code correct} is deliberately NOT banned here
     * &mdash; in a submitted result it is the aggregate correct-answer COUNT
     * (matching the frontend's InterviewResult.correct), not a per-option flag.
     */
    SUBMITTED_REVIEW(
            Set.of("isCorrect", "is_correct", "answerKey", "answer_key", "expectedAnswers", "expected_answers"),
            Fields.INTERNAL
    ),

    /** Error envelopes are {@code {error:{code,message}}} &mdash; internals still banned. */
    ERROR(Fields.ANSWER_KEY, Fields.INTERNAL);

    /** The default policy applied when a controller never sets one. Deliberately the strictest. */
    public static final ResponsePolicy DEFAULT = PUBLIC_METADATA;

    private final Set<String> bannedNormalizedKeys;

    @SafeVarargs
    ResponsePolicy(Set<String>... rawKeyGroups) {
        Set<String> normalized = new LinkedHashSet<>();
        for (Set<String> group : rawKeyGroups) {
            for (String rawKey : group) {
                normalized.add(ResponsePolicySupport.normalizeKey(rawKey));
            }
        }
        this.bannedNormalizedKeys = Collections.unmodifiableSet(normalized);
    }

    /** True if the given (raw, un-normalized) property name is banned under this policy. */
    public boolean isBanned(String rawKey) {
        return bannedNormalizedKeys.contains(ResponsePolicySupport.normalizeKey(rawKey));
    }

    /** Shared banned-field groups, ported verbatim from response-policy.ts. */
    private static final class Fields {

        /** Answer-key material &mdash; never legal outside an authorized review response. */
        static final Set<String> ANSWER_KEY = Set.of(
                "correct", "isCorrect", "is_correct",
                "correctOptionIds", "correct_option_ids",
                "answerKey", "answer_key",
                "expectedAnswers", "expected_answers",
                "correctAnswers", "correct_answers"
        );

        /** Backend internals that must never be serialized under ANY policy. */
        static final Set<String> INTERNAL = Set.of(
                "sourceQuestionIndex", "source_question_index",
                "sourceOptionIndex", "source_option_index",
                "tokenHash", "token_hash",
                "sessionToken", "session_token",
                "dataPath", "data_path",
                "databasePath", "database_path",
                "quizDataPath",
                "allowedOrigins",
                "attemptId", "attempt_id",
                "result_json", "resultJson",
                "config_json", "configJson",
                "questions_json", "questionsJson",
                "answers_json", "answersJson"
        );

        /**
         * Every form of question/option IDENTITY. The Topic Quiz contract
         * addresses a question by its exact TEXT within a quiz and nothing else,
         * so any of these on the wire (outside the Interview contract, which
         * legitimately needs questionId/optionId) is a regression.
         */
        static final Set<String> IDENTIFIER = Set.of(
                "questionId", "question_id",
                "optionId", "option_id",
                "id",
                "questionIndex", "question_index",
                "optionIndex", "option_index",
                "legacyQuestionId", "legacy_question_id",
                "legacyOptionId", "legacy_option_id",
                "displayOrder", "display_order",
                "sourceIndex", "source_index",
                "questionKey", "question_key",
                "optionKey", "option_key",
                "quizPk", "quiz_pk",
                "questionPk", "question_pk"
        );

        static Set<String> internalWithoutSessionToken() {
            Set<String> out = new LinkedHashSet<>(INTERNAL);
            out.removeIf(field -> ResponsePolicySupport.normalizeKey(field)
                    .equals(ResponsePolicySupport.normalizeKey("sessionToken")));
            return out;
        }

        private Fields() {
        }
    }
}
