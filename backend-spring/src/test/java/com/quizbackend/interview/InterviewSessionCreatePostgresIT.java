package com.quizbackend.interview;

import com.quizbackend.testsupport.postgres.CanonicalSchemaInitializer;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;

import java.sql.SQLException;
import java.util.List;
import java.util.concurrent.CompletableFuture;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * PostgreSQL/Testcontainers proof for {@link InterviewSessionRepository#createSessionSnapshot}
 * — the real-SQL counterpart to the mocked-repository proofs in {@code
 * InterviewSessionServiceTest}, and the REGRESSION coverage for the
 * batched-insert performance fix: same pattern as the pre-existing
 * {@code InterviewSessionAnswerPostgresIT} (fresh Testcontainers Postgres,
 * {@code CanonicalSchemaInitializer} applies the real schema, no mocking of
 * the repository under test).
 *
 * <p>*IT suffix, Failsafe-bound only (same convention as its siblings).
 */
@Testcontainers
@SpringBootTest
class InterviewSessionCreatePostgresIT {

    @Container
    static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer("postgres:18-alpine");

    @DynamicPropertySource
    static void datasourceProperties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        registry.add("spring.datasource.username", POSTGRES::getUsername);
        registry.add("spring.datasource.password", POSTGRES::getPassword);
        registry.add("topicquiz.receipt-secret", () -> "test-only-synthetic-topic-quiz-receipt-secret");
    }

    @BeforeAll
    static void applySchema() throws SQLException {
        CanonicalSchemaInitializer.applyTo(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
    }

    @Autowired
    private InterviewSessionRepository repository;
    @Autowired
    private JdbcTemplate jdbcTemplate;

    private static final long NOW = 1_700_000_000_000L;
    private static final long EXPIRES = NOW + 20 * 60 * 1000L;

    /** {@code questionCount} questions, 2 options each (option 1 correct), matching real generation shape. */
    private static CreateSessionInput input(String sessionId, String attemptId, int questionCount) {
        List<GeneratedQuestionSnapshot> questions = new java.util.ArrayList<>();
        for (int i = 0; i < questionCount; i++) {
            questions.add(new GeneratedQuestionSnapshot(
                    i, sessionId + ":q:" + i, "synthetic-topic", "Question " + i + "?", "single",
                    "Because " + i + ".",
                    List.of(
                            new GeneratedOptionSnapshot((i + 1) * 100 + 1, "Correct " + i, 0, true),
                            new GeneratedOptionSnapshot((i + 1) * 100 + 2, "Wrong " + i, 1, false)),
                    null));
        }
        InterviewSessionConfig config = new InterviewSessionConfig("mixed", List.of("synthetic-topic"), questionCount, null, null);
        return new CreateSessionInput(sessionId, "token-hash-" + sessionId, attemptId, config, 1200, NOW, EXPIRES, questions);
    }

    private int countRows(String table, String sessionId) {
        Integer count = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM " + table + " WHERE session_id = ?", Integer.class, sessionId);
        return count == null ? 0 : count;
    }

    @Test
    void createsAllRowsInOneCallAndTheyReadBackExactly() {
        CreateSessionInput in = input("is_create_basic", "ia_create_basic", 5);

        InterviewSessionRecord record = repository.createSessionSnapshot(in);

        assertThat(record.id()).isEqualTo("is_create_basic");
        assertThat(record.status()).isEqualTo(SessionStatus.ACTIVE);
        assertThat(record.submittedAt()).isNull();
        assertThat(record.submittedByExpiry()).isFalse();

        assertThat(countRows("session_questions", "is_create_basic")).isEqualTo(5);
        assertThat(countRows("session_options", "is_create_basic")).isEqualTo(10);

        InterviewSessionSnapshot snapshot = repository.getSessionSnapshot("is_create_basic").orElseThrow();
        assertThat(snapshot.questions()).hasSize(5);
        for (int i = 0; i < 5; i++) {
            SessionQuestionSnapshot q = snapshot.questions().get(i);
            assertThat(q.position()).isEqualTo(i);
            assertThat(q.questionId()).isEqualTo("is_create_basic:q:" + i);
            assertThat(q.options()).hasSize(2);
            assertThat(q.options().get(0).isCorrect()).isTrue();
            assertThat(q.options().get(1).isCorrect()).isFalse();
        }
    }

    @Test
    void twoSequentialSessionsAreFullyIndependent() {
        repository.createSessionSnapshot(input("is_seq_a", "ia_seq_a", 3));
        repository.createSessionSnapshot(input("is_seq_b", "ia_seq_b", 4));

        assertThat(countRows("session_questions", "is_seq_a")).isEqualTo(3);
        assertThat(countRows("session_options", "is_seq_a")).isEqualTo(6);
        assertThat(countRows("session_questions", "is_seq_b")).isEqualTo(4);
        assertThat(countRows("session_options", "is_seq_b")).isEqualTo(8);
    }

    @Test
    void concurrentSessionCreationsBothSucceedWithNoCrossContamination() {
        CompletableFuture<InterviewSessionRecord> a =
                CompletableFuture.supplyAsync(() -> repository.createSessionSnapshot(input("is_conc_a", "ia_conc_a", 6)));
        CompletableFuture<InterviewSessionRecord> b =
                CompletableFuture.supplyAsync(() -> repository.createSessionSnapshot(input("is_conc_b", "ia_conc_b", 6)));

        CompletableFuture.allOf(a, b).join();

        assertThat(a.join().id()).isEqualTo("is_conc_a");
        assertThat(b.join().id()).isEqualTo("is_conc_b");
        assertThat(countRows("session_questions", "is_conc_a")).isEqualTo(6);
        assertThat(countRows("session_options", "is_conc_a")).isEqualTo(12);
        assertThat(countRows("session_questions", "is_conc_b")).isEqualTo(6);
        assertThat(countRows("session_options", "is_conc_b")).isEqualTo(12);
    }

    /**
     * A batched multi-row INSERT must roll back completely on failure, exactly
     * like the old per-row loop did — one question deliberately carries BLANK
     * text, which the database's own CHECK constraint rejects. No session,
     * question, or option row may survive for this session id.
     */
    @Test
    void aFailurePartwayThroughLeavesNoPartialRows() {
        List<GeneratedQuestionSnapshot> questions = new java.util.ArrayList<>();
        questions.add(new GeneratedQuestionSnapshot(0, "is_rollback:q:0", "synthetic-topic", "Fine?", "single",
                "Because.", List.of(new GeneratedOptionSnapshot(101, "A", 0, true), new GeneratedOptionSnapshot(102, "B", 1, false)), null));
        // Position 1's question_text is blank — violates the DB CHECK constraint.
        questions.add(new GeneratedQuestionSnapshot(1, "is_rollback:q:1", "synthetic-topic", "   ", "single",
                "Because.", List.of(new GeneratedOptionSnapshot(201, "A", 0, true), new GeneratedOptionSnapshot(202, "B", 1, false)), null));
        InterviewSessionConfig config = new InterviewSessionConfig("mixed", List.of("synthetic-topic"), 2, null, null);

        assertThatThrownBy(() -> repository.createSessionSnapshot(
                new CreateSessionInput("is_rollback", "token-hash-rollback", "ia_rollback", config, 1200, NOW, EXPIRES, questions)))
                .isInstanceOf(DataAccessException.class);

        Integer sessionRows = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM interview_sessions WHERE id = ?", Integer.class, "is_rollback");
        assertThat(sessionRows).isZero();
        assertThat(countRows("session_questions", "is_rollback")).isEqualTo(0);
        assertThat(countRows("session_options", "is_rollback")).isEqualTo(0);
    }
}
