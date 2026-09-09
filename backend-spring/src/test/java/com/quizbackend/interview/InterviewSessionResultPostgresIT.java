package com.quizbackend.interview;

import com.quizbackend.interview.InterviewSessionRepository.FinalizeSessionInput;
import com.quizbackend.testsupport.postgres.CanonicalSchemaInitializer;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
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
import java.sql.Statement;
import java.util.Optional;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * PostgreSQL/Testcontainers hardening slice for Slice 5's submit/finalize
 * path — the real-SQL counterpart to the mocked-repository proof in
 * {@code InterviewSessionServiceTest}. Proves {@link InterviewSessionRepository#finalizeSession}/
 * {@link InterviewSessionRepository#getSubmittedResult} against a genuine
 * {@code interview_sessions.result_json} column and, most importantly, the
 * real database-enforced compare-and-swap ({@code UPDATE ... WHERE status
 * <> 'submitted'} + affected-row count) under GENUINE concurrent access —
 * something no mocked-repository unit test can actually exercise, since a
 * mock has no shared row for two threads to race over.
 *
 * <p><b>*IT suffix, Failsafe-bound, NOT Surefire-bound</b>, exactly like the
 * pre-existing {@code QuizRepositoryPostgresIT} and {@code
 * InterviewSessionAnswerPostgresIT}: runs ONLY on an explicit {@code
 * mvnw.cmd verify}, never on {@code mvnw.cmd test}/{@code clean package}.
 * This class is NEW and additive for Slice 5 — it does not modify either of
 * those two files, {@code CanonicalSchemaInitializer}, or {@code pom.xml}
 * (only reads/reuses the schema initializer, unmodified), and like them it
 * has not been run in this environment: local Docker/WSL is unavailable
 * this session, so this is PENDING verification, not a proven-green result.
 */
@Testcontainers
@SpringBootTest
class InterviewSessionResultPostgresIT {

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

    @Autowired
    private InterviewSessionRepository repository;

    /**
     * Runs once, before the Spring context is created — same ordering
     * guarantee (and the same reason) as the other two *PostgresIT classes'
     * {@code @BeforeAll}: Hibernate's {@code ddl-auto=validate} check happens
     * during context creation, which precedes any {@code @BeforeEach}, so the
     * canonical schema must already exist by then or validation fails against
     * an empty database (as it did before this fix, with "missing table
     * [quizzes]"). Schema application itself is idempotent (the migrations
     * are all {@code CREATE TABLE IF NOT EXISTS}/{@code ADD COLUMN IF NOT
     * EXISTS}), so running it once per class here — rather than once per test
     * as before — changes no behavior this class relies on.
     */
    @BeforeAll
    static void applyCanonicalSchema() throws SQLException {
        CanonicalSchemaInitializer.applyTo(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
    }

    @BeforeEach
    void seedSessions() throws SQLException {
        try (Connection connection = DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())) {

            // Fresh state for every test: this class (unlike the other two)
            // mutates rows via finalizeSession, so each test must start from
            // the same clean fixture rather than accumulating the previous
            // test's committed writes. CASCADE also clears session_questions/
            // session_options/session_answers via their FK ON DELETE CASCADE
            // to interview_sessions.
            try (Statement cleanup = connection.createStatement()) {
                cleanup.execute("TRUNCATE TABLE interview_sessions CASCADE");
            }

            // is_active: one single-select (correct=101) and one multiple-select
            // (correct={201,202}) question, spanning two topics, so scoring,
            // per-topic aggregation and percentage all get exercised together.
            insertSession(connection, "is_active", "active", FAR_FUTURE, 1200,
                    "{\"difficulty\":\"mixed\",\"topicIds\":[\"signals\",\"rxjs\"],\"questionCount\":2}");
            insertQuestion(connection, "is_active", 0, "q0", "signals", "single");
            insertOption(connection, "is_active", 0, 101, 0, true);
            insertOption(connection, "is_active", 0, 102, 1, false);
            insertQuestion(connection, "is_active", 1, "q1", "rxjs", "multiple");
            insertOption(connection, "is_active", 1, 201, 0, true);
            insertOption(connection, "is_active", 1, 202, 1, true);
            insertOption(connection, "is_active", 1, 203, 2, false);
            insertAnswer(connection, "is_active", 0, "[101]");
            insertAnswer(connection, "is_active", 1, "[201,202]");

            insertSession(connection, "is_expired_boundary", "active", PAST, 1200,
                    "{\"difficulty\":\"mixed\",\"topicIds\":[\"signals\"],\"questionCount\":1}");
            insertQuestion(connection, "is_expired_boundary", 0, "exp-q0", "signals", "single");
            insertOption(connection, "is_expired_boundary", 0, 301, 0, true);
            // deliberately unanswered — proves an expired, never-touched
            // session still finalizes cleanly with 0/1 correct.

            insertSession(connection, "is_race", "active", FAR_FUTURE, 1200,
                    "{\"difficulty\":\"mixed\",\"topicIds\":[\"signals\"],\"questionCount\":1}");
            insertQuestion(connection, "is_race", 0, "race-q0", "signals", "single");
            insertOption(connection, "is_race", 0, 401, 0, true);
            insertAnswer(connection, "is_race", 0, "[401]");
        }
    }

    private static void insertSession(Connection connection, String id, String status, long expiresAt,
            int durationSeconds, String configJson) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement("""
                INSERT INTO interview_sessions
                  (id, token_hash, status, config_json, duration_seconds, created_at, expires_at,
                   submitted_at, submitted_by_expiry, result_json, attempt_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, ?)
                """)) {
            statement.setString(1, id);
            statement.setString(2, "unused-token-hash-" + id);
            statement.setString(3, status);
            statement.setString(4, configJson);
            statement.setInt(5, durationSeconds);
            statement.setLong(6, NOW - 500);
            statement.setLong(7, expiresAt);
            statement.setString(8, "ia_" + id);
            statement.executeUpdate();
        }
    }

    private static void insertQuestion(Connection connection, String sessionId, int position, String questionId,
            String sourceQuizId, String type) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement("""
                INSERT INTO session_questions
                  (session_id, position, question_id, source_quiz_id, question_text, question_type, explanation)
                VALUES (?, ?, ?, ?, ?, ?, 'Because synthetic.')
                """)) {
            statement.setString(1, sessionId);
            statement.setInt(2, position);
            statement.setString(3, questionId);
            statement.setString(4, sourceQuizId);
            statement.setString(5, questionId + " text?");
            statement.setString(6, type);
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

    private static void insertAnswer(Connection connection, String sessionId, int position, String selectedOptionIdsJson)
            throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement("""
                INSERT INTO session_answers (session_id, question_position, selected_option_ids, updated_at)
                VALUES (?, ?, ?, ?)
                """)) {
            statement.setString(1, sessionId);
            statement.setInt(2, position);
            statement.setString(3, selectedOptionIdsJson);
            statement.setLong(4, NOW - 100);
            statement.executeUpdate();
        }
    }

    private static FinalizeSessionInput finalizeInput(String sessionId, long now) {
        return new FinalizeSessionInput(sessionId, now, topicId -> "Title:" + topicId);
    }

    // ── scoring + persistence round-trip ─────────────────────────────────

    @Test
    void finalizeScoresFromTheFrozenSnapshotAndPersistsAJsonColumnThatReadsBackIdentically() {
        FrozenInterviewResult result = repository.finalizeSession(finalizeInput("is_active", NOW));

        assertThat(result.status()).isEqualTo("submitted");
        assertThat(result.total()).isEqualTo(2);
        assertThat(result.correct()).isEqualTo(2);
        assertThat(result.percentage()).isEqualTo(100);
        assertThat(result.performance().byTopic()).hasSize(2);

        Optional<FrozenInterviewResult> reread = repository.getSubmittedResult("is_active");
        assertThat(reread).isPresent();
        assertThat(reread.get().review()).hasSize(2);
        assertThat(reread.get().percentage()).isEqualTo(100);
    }

    @Test
    void finalizeIsIdempotentASecondCallReturnsTheSameStoredResultRatherThanRescoring() {
        FrozenInterviewResult first = repository.finalizeSession(finalizeInput("is_active", NOW));
        // A later call, even with a DIFFERENT `now`, must return the SAME
        // frozen result rather than recomputing timing/percentage again.
        FrozenInterviewResult second = repository.finalizeSession(finalizeInput("is_active", NOW + 999_999));

        assertThat(second.submittedAt()).isEqualTo(first.submittedAt());
        assertThat(second.timeUsedSeconds()).isEqualTo(first.timeUsedSeconds());
        assertThat(second.percentage()).isEqualTo(first.percentage());
    }

    @Test
    void anExpiredNeverAnsweredSessionFinalizesWithZeroCorrectAndFullDurationUsed() {
        FrozenInterviewResult result = repository.finalizeSession(finalizeInput("is_expired_boundary", NOW));

        assertThat(result.submittedByExpiry()).isTrue();
        assertThat(result.correct()).isEqualTo(0);
        assertThat(result.unanswered()).isEqualTo(1);
        assertThat(result.timeUsedSeconds()).isEqualTo(result.durationSeconds());
    }

    @Test
    void getSubmittedResultIsEmptyForAStillActiveSession() {
        assertThat(repository.getSubmittedResult("is_active")).isEmpty();
    }

    // ── the atomic compare-and-swap under REAL concurrency ───────────────

    /**
     * Two threads call {@link InterviewSessionRepository#finalizeSession}
     * for the SAME active session at (as near as the JVM allows) the same
     * moment. This is the one behavior a mocked-repository test structurally
     * cannot prove: only a real database can enforce that exactly one of two
     * concurrent {@code UPDATE ... WHERE status <> 'submitted'} statements
     * affects a row. Both calls must return an IDENTICAL frozen result
     * (byte-for-byte on the fields checked below), and the session must end
     * up in exactly one final state.
     */
    @Test
    void concurrentFinalizeCallsProduceExactlyOneWinnerAndBothReturnTheSameFrozenResult() throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Callable<FrozenInterviewResult> callA = () -> repository.finalizeSession(finalizeInput("is_race", NOW));
            Callable<FrozenInterviewResult> callB = () -> repository.finalizeSession(finalizeInput("is_race", NOW + 1));

            Future<FrozenInterviewResult> futureA = pool.submit(callA);
            Future<FrozenInterviewResult> futureB = pool.submit(callB);

            FrozenInterviewResult resultA = futureA.get(30, TimeUnit.SECONDS);
            FrozenInterviewResult resultB = futureB.get(30, TimeUnit.SECONDS);

            assertThat(resultA.submittedAt()).isEqualTo(resultB.submittedAt());
            assertThat(resultA.percentage()).isEqualTo(resultB.percentage());
            assertThat(resultA.correct()).isEqualTo(resultB.correct());

            // Exactly one persisted result — a third, independent read must
            // agree with BOTH racing callers, not with neither or a mix.
            FrozenInterviewResult stored = repository.getSubmittedResult("is_race").orElseThrow();
            assertThat(stored.submittedAt()).isEqualTo(resultA.submittedAt());
        } finally {
            pool.shutdownNow();
        }
    }

    // ── corrupt / invalid stored data is never silently trusted ──────────

    @Test
    void aStoredResultThatFailsItsInvariantsOnReReadThrowsCorruptDataRatherThanBeingSilentlyAccepted() throws SQLException {
        repository.finalizeSession(finalizeInput("is_active", NOW));

        try (Connection connection = DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             PreparedStatement statement = connection.prepareStatement(
                     "UPDATE interview_sessions SET result_json = ? WHERE id = ?")) {
            // total=2 but review has only 0 entries -> fails assertInvariants on read.
            statement.setString(1, """
                    {"sessionId":"is_active","status":"submitted","submittedAt":1,"submittedByExpiry":false,
                     "total":2,"answered":2,"unanswered":0,"correct":2,"incorrect":0,"percentage":100,
                     "durationSeconds":1200,"timeUsedSeconds":0,"timeRemainingSeconds":1200,
                     "config":{"mode":"custom","presetId":null,"difficulty":"mixed","topicIds":["signals"],"questionCount":2},
                     "performance":{"byTopic":[]},"review":[]}
                    """);
            statement.setString(2, "is_active");
            statement.executeUpdate();
        }

        // parseFrozenResult re-validates on every read and throws rather than
        // returning a value — storage is never trusted merely because this
        // process wrote it earlier in this same test.
        assertThatThrownBy(() -> repository.getSubmittedResult("is_active"))
                .isInstanceOf(SessionRepositoryException.class)
                .satisfies(ex -> assertThat(((SessionRepositoryException) ex).getCategory())
                        .isEqualTo(SessionRepositoryException.Category.CORRUPT_DATA));
    }
}
