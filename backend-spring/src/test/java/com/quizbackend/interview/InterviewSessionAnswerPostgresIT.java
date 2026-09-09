package com.quizbackend.interview;

import com.quizbackend.interview.InterviewSessionRepository.FlaggedState;
import com.quizbackend.interview.InterviewSessionRepository.SaveAnswerInput;
import com.quizbackend.interview.InterviewSessionRepository.SavedAnswerState;
import com.quizbackend.interview.InterviewSessionRepository.SessionAnswerRecord;
import com.quizbackend.interview.InterviewSessionRepository.SetFlaggedInput;
import com.quizbackend.testsupport.postgres.CanonicalSchemaInitializer;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.Types;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * PostgreSQL/Testcontainers hardening slice for Slice 4's answer/flag
 * persistence — the real-SQL counterpart to the mocked-repository proof in
 * {@code InterviewSessionServiceTest}. Proves {@link InterviewSessionRepository#saveAnswer}/
 * {@link InterviewSessionRepository#setFlagged}/{@link InterviewSessionRepository#getAnswers}
 * against genuine {@code session_questions}/{@code session_options}/
 * {@code session_answers} rows and the composite-key constraints those
 * tables actually enforce (the exact reason this slice stayed on plain JDBC
 * rather than a JPA entity).
 *
 * <p><b>*IT suffix, Failsafe-bound, NOT Surefire-bound</b>, exactly like the
 * pre-existing {@code QuizRepositoryPostgresIT}: runs ONLY on an explicit
 * {@code mvnw.cmd verify}, never on {@code mvnw.cmd test}/{@code clean
 * package}. This class is NEW and additive — it does not modify
 * {@code QuizRepositoryPostgresIT} or {@code CanonicalSchemaInitializer}
 * (only reads/reuses the latter, unmodified), and like them it has not been
 * run in this environment: local Docker/WSL is unavailable this session, so
 * this is pending verification, not a proven-green result.
 *
 * <p>Seeds {@code interview_sessions}/{@code session_questions}/
 * {@code session_options} directly via JDBC — these tables have no
 * dependency on the quiz bank (no FK to {@code quizzes}), so no quiz
 * metadata seeding is needed here, unlike {@code QuizRepositoryPostgresIT}.
 */
@Testcontainers
@SpringBootTest
class InterviewSessionAnswerPostgresIT {

    @Container
    static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer("postgres:18-alpine");

    @DynamicPropertySource
    static void datasourceProperties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        registry.add("spring.datasource.username", POSTGRES::getUsername);
        registry.add("spring.datasource.password", POSTGRES::getPassword);
        // See QuizRepositoryPostgresIT's identical registration: this class
        // also runs under the DEFAULT profile, so TopicQuizReceiptSecret's
        // fail-closed constructor needs a synthetic, obviously-fake value
        // here rather than a real TOPIC_QUIZ_RECEIPT_SECRET.
        registry.add("topicquiz.receipt-secret", () -> "test-only-synthetic-topic-quiz-receipt-secret");
    }

    private static final long NOW = 1_700_000_000_000L;
    private static final long FAR_FUTURE = NOW + 20 * 60 * 1000L;
    private static final long PAST = NOW - 1;

    @BeforeAll
    static void applySchemaAndSeedSessions() throws SQLException {
        CanonicalSchemaInitializer.applyTo(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());

        try (Connection connection = DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())) {

            // is_active: one single-select question (position 0, options
            // 101/102) and one multiple-select question (position 1, options
            // 201/202/203) — enough to prove both selection-count rules.
            insertSession(connection, "is_active", "active", FAR_FUTURE, null, "{\"difficulty\":\"mixed\",\"topicIds\":[\"x\"],\"questionCount\":2}");
            insertQuestion(connection, "is_active", 0, "q0", "single");
            insertOption(connection, "is_active", 0, 101, 0, true);
            insertOption(connection, "is_active", 0, 102, 1, false);
            insertQuestion(connection, "is_active", 1, "q1", "multiple");
            insertOption(connection, "is_active", 1, 201, 0, true);
            insertOption(connection, "is_active", 1, 202, 1, true);
            insertOption(connection, "is_active", 1, 203, 2, false);

            // is_other: a SEPARATE session with its own option 901 — used to
            // prove an option cannot cross session boundaries even if it
            // otherwise looks well-formed.
            insertSession(connection, "is_other", "active", FAR_FUTURE, null, "{\"difficulty\":\"mixed\",\"topicIds\":[\"x\"],\"questionCount\":1}");
            insertQuestion(connection, "is_other", 0, "other-q0", "single");
            insertOption(connection, "is_other", 0, 901, 0, true);

            insertSession(connection, "is_expired_boundary", "active", PAST, null, "{\"difficulty\":\"mixed\",\"topicIds\":[\"x\"],\"questionCount\":1}");
            insertQuestion(connection, "is_expired_boundary", 0, "exp-q0", "single");
            insertOption(connection, "is_expired_boundary", 0, 301, 0, true);

            // A submitted session must carry a non-null submitted_at — the
            // canonical schema's own CHECK (status <> 'submitted' OR
            // submitted_at IS NOT NULL) enforces this, so this fixture must
            // supply one rather than relying on the NULL every other (still
            // active) fixture above correctly uses.
            insertSession(connection, "is_submitted", "submitted", FAR_FUTURE, NOW, "{\"difficulty\":\"mixed\",\"topicIds\":[\"x\"],\"questionCount\":1}");
            insertQuestion(connection, "is_submitted", 0, "sub-q0", "single");
            insertOption(connection, "is_submitted", 0, 401, 0, true);
        }
    }

    private static void insertSession(Connection connection, String id, String status, long expiresAt,
            Long submittedAt, String configJson) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement("""
                INSERT INTO interview_sessions
                  (id, token_hash, status, config_json, duration_seconds, created_at, expires_at,
                   submitted_at, submitted_by_expiry, result_json, attempt_id)
                VALUES (?, ?, ?, ?, 1200, ?, ?, ?, 0, NULL, ?)
                """)) {
            statement.setString(1, id);
            statement.setString(2, "unused-token-hash-" + id);
            statement.setString(3, status);
            statement.setString(4, configJson);
            statement.setLong(5, NOW - 500);
            statement.setLong(6, expiresAt);
            if (submittedAt != null) {
                statement.setLong(7, submittedAt);
            } else {
                statement.setNull(7, Types.BIGINT);
            }
            statement.setString(8, "ia_" + id);
            statement.executeUpdate();
        }
    }

    private static void insertQuestion(Connection connection, String sessionId, int position, String questionId, String type)
            throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement("""
                INSERT INTO session_questions
                  (session_id, position, question_id, source_quiz_id, question_text, question_type, explanation)
                VALUES (?, ?, ?, 'synthetic-topic', ?, ?, 'Because synthetic.')
                """)) {
            statement.setString(1, sessionId);
            statement.setInt(2, position);
            statement.setString(3, questionId);
            statement.setString(4, questionId + " text?");
            statement.setString(5, type);
            statement.executeUpdate();
        }
    }

    private static void insertOption(Connection connection, String sessionId, int position, int optionId,
            int displayOrder, boolean isCorrect) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement("""
                INSERT INTO session_options
                  (session_id, question_position, option_id, option_text, display_order, is_correct)
                VALUES (?, ?, ?, ?, ?, ?)
                """)) {
            statement.setString(1, sessionId);
            statement.setInt(2, position);
            statement.setInt(3, optionId);
            statement.setString(4, "Option " + optionId);
            statement.setInt(5, displayOrder);
            statement.setInt(6, isCorrect ? 1 : 0);
            statement.executeUpdate();
        }
    }

    @Autowired
    private InterviewSessionRepository repository;

    // ── A. Single-answer replace semantics ──────────────────────────────

    @Test
    void firstSelectionPersistsAndASecondSelectionReplacesIt() {
        SavedAnswerState first = repository.saveAnswer(new SaveAnswerInput("is_active", "q0", List.of(101), NOW));
        assertThat(first.selectedOptionIds()).containsExactly(101);

        SavedAnswerState second = repository.saveAnswer(new SaveAnswerInput("is_active", "q0", List.of(102), NOW + 1));
        assertThat(second.selectedOptionIds()).containsExactly(102);

        List<SessionAnswerRecord> stored = repository.getAnswers("is_active");
        SessionAnswerRecord row = stored.stream().filter(a -> a.position() == 0).findFirst().orElseThrow();
        assertThat(row.selectedOptionIds()).containsExactly(102);
    }

    @Test
    void aSingleQuestionRejectsMoreThanOneSelection() {
        assertThatThrownBy(() -> repository.saveAnswer(new SaveAnswerInput("is_active", "q0", List.of(101, 102), NOW)))
                .isInstanceOf(SessionRepositoryException.class)
                .satisfies(ex -> assertThat(((SessionRepositoryException) ex).getCategory())
                        .isEqualTo(SessionRepositoryException.Category.INVALID_SELECTION_COUNT));
    }

    // ── B. Multiple-answer (complete-set) semantics ─────────────────────

    @Test
    void multipleAnswerAcceptsAGrowingThenShrinkingCompleteSet() {
        repository.saveAnswer(new SaveAnswerInput("is_active", "q1", List.of(201), NOW));
        SavedAnswerState grown = repository.saveAnswer(new SaveAnswerInput("is_active", "q1", List.of(201, 202), NOW + 1));
        assertThat(grown.selectedOptionIds()).containsExactly(201, 202);

        // The client "toggles 201 off" by sending the resulting complete set.
        SavedAnswerState shrunk = repository.saveAnswer(new SaveAnswerInput("is_active", "q1", List.of(202), NOW + 2));
        assertThat(shrunk.selectedOptionIds()).containsExactly(202);
    }

    @Test
    void emptySelectionDeletesTheAnswerRowAndUnanswersTheQuestion() {
        repository.saveAnswer(new SaveAnswerInput("is_active", "q1", List.of(201, 203), NOW));
        SavedAnswerState cleared = repository.saveAnswer(new SaveAnswerInput("is_active", "q1", List.of(), NOW + 1));

        assertThat(cleared.selectedOptionIds()).isEmpty();
        assertThat(repository.getAnswers("is_active").stream().noneMatch(a -> a.position() == 1)).isTrue();
    }

    // ── ownership / frozen-snapshot membership ──────────────────────────

    @Test
    void anOptionFromAnotherSessionIsRejectedEvenThoughItExists() {
        assertThatThrownBy(() -> repository.saveAnswer(new SaveAnswerInput("is_active", "q0", List.of(901), NOW)))
                .isInstanceOf(SessionRepositoryException.class)
                .satisfies(ex -> assertThat(((SessionRepositoryException) ex).getCategory())
                        .isEqualTo(SessionRepositoryException.Category.OPTION_NOT_IN_QUESTION));
    }

    @Test
    void anUnknownQuestionIdIsRejected() {
        assertThatThrownBy(() -> repository.saveAnswer(new SaveAnswerInput("is_active", "ghost-question", List.of(101), NOW)))
                .isInstanceOf(SessionRepositoryException.class)
                .satisfies(ex -> assertThat(((SessionRepositoryException) ex).getCategory())
                        .isEqualTo(SessionRepositoryException.Category.QUESTION_NOT_IN_SESSION));
    }

    // ── expiry / submitted state ─────────────────────────────────────────

    @Test
    void aSessionPastItsDeadlineRejectsTheSaveWithSessionExpired() {
        assertThatThrownBy(() -> repository.saveAnswer(new SaveAnswerInput("is_expired_boundary", "exp-q0", List.of(301), NOW)))
                .isInstanceOf(SessionRepositoryException.class)
                .satisfies(ex -> assertThat(((SessionRepositoryException) ex).getCategory())
                        .isEqualTo(SessionRepositoryException.Category.SESSION_EXPIRED));
    }

    @Test
    void aSubmittedSessionRejectsTheSaveWithSessionNotActive() {
        assertThatThrownBy(() -> repository.saveAnswer(new SaveAnswerInput("is_submitted", "sub-q0", List.of(401), NOW)))
                .isInstanceOf(SessionRepositoryException.class)
                .satisfies(ex -> assertThat(((SessionRepositoryException) ex).getCategory())
                        .isEqualTo(SessionRepositoryException.Category.SESSION_NOT_ACTIVE));
    }

    // ── Mark for Review ──────────────────────────────────────────────────

    @Test
    void flagRoundTripsTrueThenFalseIndependentlyOfAnswers() {
        repository.saveAnswer(new SaveAnswerInput("is_active", "q0", List.of(101), NOW));

        FlaggedState flagged = repository.setFlagged(new SetFlaggedInput("is_active", "q0", true, NOW + 1));
        assertThat(flagged.flagged()).isTrue();

        // The answer must be untouched by the flag change.
        SessionAnswerRecord afterFlag = repository.getAnswers("is_active").stream()
                .filter(a -> a.position() == 0).findFirst().orElseThrow();
        assertThat(afterFlag.selectedOptionIds()).containsExactly(101);

        FlaggedState unflagged = repository.setFlagged(new SetFlaggedInput("is_active", "q0", false, NOW + 2));
        assertThat(unflagged.flagged()).isFalse();
    }
}
