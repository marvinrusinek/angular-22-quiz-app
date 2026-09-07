package com.quizbackend.interview;

import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

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

    private final JdbcTemplate jdbcTemplate;
    private final ObjectMapper objectMapper;

    public InterviewSessionRepository(JdbcTemplate jdbcTemplate, ObjectMapper objectMapper) {
        this.jdbcTemplate = jdbcTemplate;
        this.objectMapper = objectMapper;
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
}
