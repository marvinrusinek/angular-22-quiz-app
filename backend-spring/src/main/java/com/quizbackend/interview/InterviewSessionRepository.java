package com.quizbackend.interview;

import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Interview session persistence — port of the Node reference's
 * {@code session.repository.ts}, scoped to what create/resume need
 * (creation, authentication lookup, expiry flip, snapshot read). Every
 * statement is parameterized; no value is ever interpolated into SQL.
 *
 * <p>Deliberately plain JDBC ({@link JdbcTemplate}), NOT a JPA
 * {@code @Entity}: {@code session_questions}/{@code session_options} have
 * composite primary keys and composite foreign keys onto that composite key,
 * which Hibernate can model but only through {@code @IdClass}/
 * {@code @EmbeddedId} machinery that adds real mapping risk for no benefit
 * here — the Slice 3 instructions explicitly prefer "the least risky
 * approach" when a native query is safer and clearer than forcing Hibernate
 * onto a PostgreSQL-specific construct. Hibernate's {@code ddl-auto=validate}
 * simply never inspects these tables, which is fine: validation only applies
 * to tables an {@code @Entity} maps.
 */
@Repository
public class InterviewSessionRepository {

    private static final String INSERT_SESSION = """
            INSERT INTO interview_sessions
              (id, token_hash, status, config_json, duration_seconds,
               created_at, expires_at, submitted_at, submitted_by_expiry, result_json, attempt_id)
            VALUES (?, ?, 'active', ?, ?, ?, ?, NULL, 0, NULL, ?)
            """;

    private static final String INSERT_QUESTION = """
            INSERT INTO session_questions
              (session_id, position, question_id, source_quiz_id, question_text, question_type, explanation,
               code, code_language, code_filename)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """;

    private static final String INSERT_OPTION = """
            INSERT INTO session_options
              (session_id, question_position, option_id, option_text, display_order, is_correct)
            VALUES (?, ?, ?, ?, ?, ?)
            """;

    private static final String SELECT_SESSION = """
            SELECT id, token_hash, status, config_json, duration_seconds,
                   created_at, expires_at, submitted_at, submitted_by_expiry, attempt_id
              FROM interview_sessions WHERE id = ?
            """;

    private static final String SELECT_AUTH =
            "SELECT id, token_hash, status, expires_at FROM interview_sessions WHERE id = ?";

    private static final String EXPIRE_IF_DUE = """
            UPDATE interview_sessions SET status = 'expired'
             WHERE id = ? AND status = 'active' AND expires_at <= ?
            """;

    private static final String SELECT_QUESTIONS = """
            SELECT position, question_id, source_quiz_id, question_text, question_type, explanation, flagged,
                   code, code_language, code_filename
              FROM session_questions WHERE session_id = ? ORDER BY position
            """;

    private static final String SELECT_OPTIONS = """
            SELECT question_position, option_id, option_text, display_order, is_correct
              FROM session_options WHERE session_id = ? ORDER BY question_position, display_order
            """;

    // ── answer/flag mutation (Slice 4) ──────────────────────────────────

    private static final String SELECT_STATE_FOR_UPDATE =
            "SELECT id, status, expires_at FROM interview_sessions WHERE id = ?";

    private static final String SELECT_QUESTION_BY_PUBLIC_ID = """
            SELECT position, question_type FROM session_questions
             WHERE session_id = ? AND question_id = ?
            """;

    private static final String UPDATE_FLAGGED =
            "UPDATE session_questions SET flagged = ? WHERE session_id = ? AND position = ?";

    private static final String SELECT_OPTION_IDS_FOR_QUESTION = """
            SELECT option_id FROM session_options
             WHERE session_id = ? AND question_position = ?
            """;

    private static final String UPSERT_ANSWER = """
            INSERT INTO session_answers (session_id, question_position, selected_option_ids, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT (session_id, question_position)
            DO UPDATE SET selected_option_ids = excluded.selected_option_ids,
                          updated_at          = excluded.updated_at
            """;

    private static final String DELETE_ANSWER =
            "DELETE FROM session_answers WHERE session_id = ? AND question_position = ?";

    private static final String COUNT_ANSWERS = "SELECT COUNT(*) FROM session_answers WHERE session_id = ?";
    private static final String COUNT_QUESTIONS = "SELECT COUNT(*) FROM session_questions WHERE session_id = ?";

    private static final String SELECT_ANSWERS = """
            SELECT question_position, selected_option_ids, updated_at
              FROM session_answers WHERE session_id = ? ORDER BY question_position
            """;

    /**
     * Guarded on {@code status = 'active'}, no time comparison — a literal
     * port of the Node reference's own separate {@code EXPIRE_NOW} constant
     * (distinct from {@link #EXPIRE_IF_DUE}, which also re-checks the
     * deadline). Used only from the catch-path below, where the deadline has
     * already been established by the failed check that triggered it.
     */
    private static final String EXPIRE_NOW =
            "UPDATE interview_sessions SET status = 'expired' WHERE id = ? AND status = 'active'";

    private final JdbcTemplate jdbcTemplate;
    private final ObjectMapper objectMapper;
    private final TransactionTemplate transactionTemplate;

    public InterviewSessionRepository(JdbcTemplate jdbcTemplate, ObjectMapper objectMapper,
            PlatformTransactionManager transactionManager) {
        this.jdbcTemplate = jdbcTemplate;
        this.objectMapper = objectMapper;
        // Programmatic, not @Transactional: doSaveAnswer/doSetFlagged below
        // are called from WITHIN this same class (saveAnswer/setFlagged), so
        // an @Transactional annotation on a private/self-invoked method would
        // be silently ignored by Spring's proxy-based AOP. TransactionTemplate
        // sidesteps that entirely and mirrors the Node reference's own
        // explicit `db.transaction(async client => {...})` callback shape
        // more directly than a declarative annotation would anyway.
        this.transactionTemplate = new TransactionTemplate(transactionManager);
    }

    public record SessionAuthenticationRecord(String sessionId, String tokenHash, SessionStatus status, long expiresAt) {
    }

    private String toConfigJson(InterviewSessionConfig config) {
        Map<String, Object> json = new LinkedHashMap<>();
        json.put("difficulty", config.difficulty());
        json.put("topicIds", config.topicIds());
        json.put("questionCount", config.questionCount());
        if (config.presetId() != null) {
            json.put("presetId", config.presetId());
        }
        if (config.presetName() != null) {
            json.put("presetName", config.presetName());
        }
        return objectMapper.writeValueAsString(json);
    }

    private InterviewSessionConfig parseConfig(String raw, String sessionId) {
        JsonNode node;
        try {
            node = objectMapper.readTree(raw);
        } catch (RuntimeException e) {
            throw new SessionRepositoryException(SessionRepositoryException.Category.CORRUPT_DATA,
                    "Session " + sessionId + " has unreadable config");
        }
        if (!node.isObject() || !node.path("difficulty").isString()
                || !node.path("topicIds").isArray() || !node.path("questionCount").isIntegralNumber()) {
            throw new SessionRepositoryException(SessionRepositoryException.Category.CORRUPT_DATA,
                    "Session " + sessionId + " has an invalid config");
        }
        List<String> topicIds = new ArrayList<>();
        for (JsonNode topic : node.path("topicIds")) {
            if (!topic.isString()) {
                throw new SessionRepositoryException(SessionRepositoryException.Category.CORRUPT_DATA,
                        "Session " + sessionId + " has an invalid config");
            }
            topicIds.add(topic.asString());
        }
        String presetId = node.path("presetId").isString() ? node.path("presetId").asString() : null;
        String presetName = node.path("presetName").isString() ? node.path("presetName").asString() : null;
        return new InterviewSessionConfig(node.path("difficulty").asString(), topicIds,
                node.path("questionCount").asInt(), presetId, presetName);
    }

    @Transactional
    public InterviewSessionRecord createSessionSnapshot(CreateSessionInput input) {
        validateCreateInput(input);
        String configJson = toConfigJson(input.config());

        try {
            jdbcTemplate.update(INSERT_SESSION, input.id(), input.tokenHash(), configJson,
                    input.durationSeconds(), input.createdAt(), input.expiresAt(), input.attemptId());

            for (GeneratedQuestionSnapshot question : input.questions()) {
                CandidateCodeSnippet snippet = question.codeSnippet();
                jdbcTemplate.update(INSERT_QUESTION, input.id(), question.position(), question.questionId(),
                        question.sourceQuizId(), question.questionText(), question.questionType(), question.explanation(),
                        snippet == null ? null : snippet.code(),
                        snippet == null ? null : snippet.language(),
                        snippet == null ? null : snippet.filename());

                for (GeneratedOptionSnapshot option : question.options()) {
                    jdbcTemplate.update(INSERT_OPTION, input.id(), question.position(), option.optionId(),
                            option.optionText(), option.displayOrder(), option.isCorrect() ? 1 : 0);
                }
            }
        } catch (DuplicateKeyException e) {
            throw new SessionRepositoryException(SessionRepositoryException.Category.CONSTRAINT,
                    "Session violates a uniqueness constraint");
        }

        return getSessionById(input.id())
                .orElseThrow(() -> new SessionRepositoryException(
                        SessionRepositoryException.Category.NOT_FOUND, "Session vanished immediately after creation"));
    }

    private void validateCreateInput(CreateSessionInput input) {
        if (input.questions().isEmpty()) {
            throw new SessionRepositoryException(SessionRepositoryException.Category.VALIDATION,
                    "A session must contain at least one question");
        }
        java.util.Set<Integer> positions = new java.util.LinkedHashSet<>();
        java.util.Set<String> questionIds = new java.util.LinkedHashSet<>();
        for (int i = 0; i < input.questions().size(); i++) {
            GeneratedQuestionSnapshot question = input.questions().get(i);
            if (!positions.add(question.position())) {
                throw new SessionRepositoryException(SessionRepositoryException.Category.VALIDATION,
                        "Duplicate question position");
            }
            if (!questionIds.add(question.questionId())) {
                throw new SessionRepositoryException(SessionRepositoryException.Category.VALIDATION,
                        "Duplicate question id within the session");
            }
            if (question.options().isEmpty()) {
                throw new SessionRepositoryException(SessionRepositoryException.Category.VALIDATION,
                        "A question must contain at least one option");
            }
        }
        for (int i = 0; i < input.questions().size(); i++) {
            if (!positions.contains(i)) {
                throw new SessionRepositoryException(SessionRepositoryException.Category.VALIDATION,
                        "Question positions must be contiguous from zero");
            }
        }
    }

    public Optional<InterviewSessionRecord> getSessionById(String sessionId) {
        List<InterviewSessionRecord> rows = jdbcTemplate.query(SELECT_SESSION, (rs, rowNum) ->
                        new InterviewSessionRecord(
                                rs.getString("id"),
                                rs.getString("token_hash"),
                                SessionStatus.fromWireValue(rs.getString("status")),
                                parseConfig(rs.getString("config_json"), rs.getString("id")),
                                rs.getInt("duration_seconds"),
                                rs.getLong("created_at"),
                                rs.getLong("expires_at"),
                                rs.getObject("submitted_at") == null ? null : rs.getLong("submitted_at"),
                                rs.getInt("submitted_by_expiry") == 1,
                                rs.getString("attempt_id")),
                sessionId);
        return rows.stream().findFirst();
    }

    public Optional<SessionAuthenticationRecord> getSessionAuthenticationRecord(String sessionId) {
        List<SessionAuthenticationRecord> rows = jdbcTemplate.query(SELECT_AUTH, (rs, rowNum) ->
                        new SessionAuthenticationRecord(
                                rs.getString("id"),
                                rs.getString("token_hash"),
                                SessionStatus.fromWireValue(rs.getString("status")),
                                rs.getLong("expires_at")),
                sessionId);
        return rows.stream().findFirst();
    }

    /** Atomically flip an ACTIVE session to expired when its deadline has passed. */
    public void markExpiredIfDue(String sessionId, long now) {
        jdbcTemplate.update(EXPIRE_IF_DUE, sessionId, now);
    }

    public Optional<InterviewSessionSnapshot> getSessionSnapshot(String sessionId) {
        Optional<InterviewSessionRecord> session = getSessionById(sessionId);
        if (session.isEmpty()) {
            return Optional.empty();
        }

        record OptionRow(int questionPosition, int optionId, String optionText, int displayOrder, boolean isCorrect) {
        }
        List<OptionRow> optionRows = jdbcTemplate.query(SELECT_OPTIONS, (rs, rowNum) -> new OptionRow(
                rs.getInt("question_position"), rs.getInt("option_id"), rs.getString("option_text"),
                rs.getInt("display_order"), rs.getInt("is_correct") == 1), sessionId);

        Map<Integer, List<SessionOptionSnapshot>> optionsByPosition = new LinkedHashMap<>();
        for (OptionRow row : optionRows) {
            optionsByPosition.computeIfAbsent(row.questionPosition(), key -> new ArrayList<>())
                    .add(new SessionOptionSnapshot(row.optionId(), row.optionText(), row.displayOrder(), row.isCorrect()));
        }

        List<SessionQuestionSnapshot> questions = jdbcTemplate.query(SELECT_QUESTIONS, (rs, rowNum) -> {
            int position = rs.getInt("position");
            String code = rs.getString("code");
            CandidateCodeSnippet snippet = code == null ? null
                    : new CandidateCodeSnippet(rs.getString("code_language"), code, rs.getString("code_filename"));
            return new SessionQuestionSnapshot(
                    position,
                    rs.getString("question_id"),
                    rs.getString("source_quiz_id"),
                    rs.getString("question_text"),
                    rs.getString("question_type"),
                    rs.getString("explanation"),
                    optionsByPosition.getOrDefault(position, List.of()),
                    rs.getInt("flagged") == 1,
                    snippet);
        }, sessionId);

        return Optional.of(new InterviewSessionSnapshot(session.get(), questions));
    }

    // ── answer/flag mutation (Slice 4) ──────────────────────────────────

    public record SaveAnswerInput(String sessionId, String questionId, List<Integer> selectedOptionIds, long now) {
    }

    public record SavedAnswerState(String questionId, List<Integer> selectedOptionIds, long answeredCount, long questionCount) {
    }

    public record SetFlaggedInput(String sessionId, String questionId, boolean flagged, long now) {
    }

    public record FlaggedState(String questionId, boolean flagged) {
    }

    public record SessionAnswerRecord(int position, List<Integer> selectedOptionIds, long updatedAt) {
    }

    private record SessionStateRow(String status, long expiresAt) {
    }

    private record QuestionLookupRow(int position, String questionType) {
    }

    /**
     * Save or clear ONE question's selection, entirely inside a single
     * transaction: state check, expiry check, membership checks and the
     * write all happen together — port of the Node reference's own
     * {@code saveAnswer}. {@code selectedOptionIds} is the COMPLETE current
     * selection (empty clears the answer), never an add/remove toggle at
     * this layer — the toggle behavior the product exhibits is computed by
     * the caller (Angular), which sends the resulting full set each time.
     *
     * <p>On a SESSION_EXPIRED failure, the deadline flip is applied AFTER
     * the transaction above has rolled back, via a separate, unwrapped
     * {@code jdbcTemplate} call — exactly mirroring the Node reference's own
     * split between its pinned transactional {@code client} and the raw
     * {@code db} handle for this one case: throwing rolls the transaction
     * back, which would undo the flip if it were applied inside it.
     */
    public SavedAnswerState saveAnswer(SaveAnswerInput input) {
        try {
            return transactionTemplate.execute(status -> doSaveAnswer(input));
        } catch (SessionRepositoryException e) {
            if (e.getCategory() == SessionRepositoryException.Category.SESSION_EXPIRED) {
                jdbcTemplate.update(EXPIRE_NOW, input.sessionId());
            }
            throw e;
        }
    }

    private SavedAnswerState doSaveAnswer(SaveAnswerInput input) {
        checkActiveAndUnexpired(input.sessionId(), input.now());

        QuestionLookupRow question = lookupQuestion(input.sessionId(), input.questionId());
        int position = question.position();

        List<Integer> selected = new ArrayList<>(input.selectedOptionIds());

        if (selected.isEmpty()) {
            jdbcTemplate.update(DELETE_ANSWER, input.sessionId(), position);
            return finalAnswerState(input.sessionId(), input.questionId(), List.of());
        }

        // Single and trueFalse are both single-selection.
        if (!question.questionType().equals("multiple") && selected.size() != 1) {
            throw new SessionRepositoryException(SessionRepositoryException.Category.INVALID_SELECTION_COUNT,
                    "This question accepts exactly one selection");
        }

        // Ownership is resolved from the FROZEN snapshot, scoped by session
        // AND question position — never from the numeric option-id formula,
        // which collides across questions by design.
        List<Integer> owned = jdbcTemplate.query(SELECT_OPTION_IDS_FOR_QUESTION,
                (rs, rowNum) -> rs.getInt("option_id"), input.sessionId(), position);
        Set<Integer> ownedSet = new HashSet<>(owned);

        if (selected.size() > ownedSet.size()) {
            throw new SessionRepositoryException(SessionRepositoryException.Category.INVALID_SELECTION_COUNT,
                    "More selections than this question has options");
        }
        for (Integer optionId : selected) {
            if (!ownedSet.contains(optionId)) {
                throw new SessionRepositoryException(SessionRepositoryException.Category.OPTION_NOT_IN_QUESTION,
                        "Selected option does not belong to this question");
            }
        }

        // Canonical ascending order: selection order carries no meaning
        // anywhere in the app, so sorting makes repeated saves
        // byte-identical and comparison trivial.
        List<Integer> canonical = new ArrayList<>(selected);
        Collections.sort(canonical);

        jdbcTemplate.update(UPSERT_ANSWER, input.sessionId(), position, writeIntArrayJson(canonical), input.now());

        return finalAnswerState(input.sessionId(), input.questionId(), canonical);
    }

    /**
     * Set or clear the Mark-for-Review flag for ONE question. Never touches
     * {@code session_answers} — marking never creates, requires or implies
     * an answer. Mirrors {@link #saveAnswer}'s transaction/expiry-flip shape
     * but skips every selection/ownership check, since a flag carries no
     * selection.
     */
    public FlaggedState setFlagged(SetFlaggedInput input) {
        try {
            return transactionTemplate.execute(status -> doSetFlagged(input));
        } catch (SessionRepositoryException e) {
            if (e.getCategory() == SessionRepositoryException.Category.SESSION_EXPIRED) {
                jdbcTemplate.update(EXPIRE_NOW, input.sessionId());
            }
            throw e;
        }
    }

    private FlaggedState doSetFlagged(SetFlaggedInput input) {
        checkActiveAndUnexpired(input.sessionId(), input.now());

        QuestionLookupRow question = lookupQuestion(input.sessionId(), input.questionId());
        jdbcTemplate.update(UPDATE_FLAGGED, input.flagged() ? 1 : 0, input.sessionId(), question.position());

        return new FlaggedState(input.questionId(), input.flagged());
    }

    private void checkActiveAndUnexpired(String sessionId, long now) {
        List<SessionStateRow> stateRows = jdbcTemplate.query(SELECT_STATE_FOR_UPDATE,
                (rs, rowNum) -> new SessionStateRow(rs.getString("status"), rs.getLong("expires_at")), sessionId);
        if (stateRows.isEmpty()) {
            throw new SessionRepositoryException(SessionRepositoryException.Category.SESSION_NOT_FOUND, "Session not found");
        }
        SessionStateRow state = stateRows.get(0);
        if (state.status().equals("submitted")) {
            throw new SessionRepositoryException(SessionRepositoryException.Category.SESSION_NOT_ACTIVE, "Session already submitted");
        }
        if (state.status().equals("expired")) {
            throw new SessionRepositoryException(SessionRepositoryException.Category.SESSION_EXPIRED, "Session expired");
        }
        // BOUNDARY: now >= expiresAt is expired. A save exactly AT the
        // deadline fails, one millisecond before succeeds.
        if (now >= state.expiresAt()) {
            throw new SessionRepositoryException(SessionRepositoryException.Category.SESSION_EXPIRED, "Session expired");
        }
    }

    private QuestionLookupRow lookupQuestion(String sessionId, String questionId) {
        List<QuestionLookupRow> rows = jdbcTemplate.query(SELECT_QUESTION_BY_PUBLIC_ID,
                (rs, rowNum) -> new QuestionLookupRow(rs.getInt("position"), rs.getString("question_type")),
                sessionId, questionId);
        if (rows.isEmpty()) {
            // Covers both "no such question" and "belongs to another
            // session" — the lookup is scoped by session_id, so neither is
            // distinguishable.
            throw new SessionRepositoryException(SessionRepositoryException.Category.QUESTION_NOT_IN_SESSION,
                    "Question does not belong to this session");
        }
        return rows.get(0);
    }

    /**
     * Counts derived from persisted rows — never from anything the caller
     * sent. Read via the SAME {@code jdbcTemplate}; the enclosing
     * {@link TransactionTemplate} call keeps this on the in-flight
     * transaction's connection, so the counts reflect what this very
     * transaction just wrote, not a possibly-stale snapshot from elsewhere.
     */
    private SavedAnswerState finalAnswerState(String sessionId, String questionId, List<Integer> selectedOptionIds) {
        Long answered = jdbcTemplate.queryForObject(COUNT_ANSWERS, Long.class, sessionId);
        Long questions = jdbcTemplate.queryForObject(COUNT_QUESTIONS, Long.class, sessionId);
        return new SavedAnswerState(questionId, selectedOptionIds, answered, questions);
    }

    private String writeIntArrayJson(List<Integer> values) {
        return objectMapper.writeValueAsString(values);
    }

    /**
     * Persisted selections for a whole session, ordered by question
     * position. Every JSON column is parsed AND revalidated on read — "this
     * process wrote it" is not a guarantee it is still well-formed — exactly
     * like the Node reference's own {@code parseSelectedOptionIds}.
     */
    public List<SessionAnswerRecord> getAnswers(String sessionId) {
        return jdbcTemplate.query(SELECT_ANSWERS, (rs, rowNum) -> {
            int position = rs.getInt("question_position");
            List<Integer> ids = parseSelectedOptionIdsJson(
                    rs.getString("selected_option_ids"), "Session " + sessionId + " answer " + position);
            return new SessionAnswerRecord(position, ids, rs.getLong("updated_at"));
        }, sessionId);
    }

    /** Validate a stored answer array: an array of unique integers, non-empty. */
    private List<Integer> parseSelectedOptionIdsJson(String raw, String context) {
        JsonNode node;
        try {
            node = objectMapper.readTree(raw);
        } catch (RuntimeException e) {
            throw new SessionRepositoryException(SessionRepositoryException.Category.CORRUPT_DATA,
                    context + " has unreadable selections");
        }
        if (!node.isArray() || node.isEmpty()) {
            throw new SessionRepositoryException(SessionRepositoryException.Category.CORRUPT_DATA,
                    context + " has invalid selections");
        }
        List<Integer> ids = new ArrayList<>();
        Set<Integer> seen = new HashSet<>();
        for (JsonNode element : node) {
            if (!element.isIntegralNumber()) {
                throw new SessionRepositoryException(SessionRepositoryException.Category.CORRUPT_DATA,
                        context + " has a non-integer selection");
            }
            int value = element.asInt();
            if (!seen.add(value)) {
                throw new SessionRepositoryException(SessionRepositoryException.Category.CORRUPT_DATA,
                        context + " has duplicate selections");
            }
            ids.add(value);
        }
        return ids;
    }
}
