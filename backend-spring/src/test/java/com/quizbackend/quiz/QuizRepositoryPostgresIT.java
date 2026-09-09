package com.quizbackend.quiz;

import com.quizbackend.quiz.dto.QuizMetadataDto;
import com.quizbackend.quiz.entity.QuizEntity;
import com.quizbackend.testsupport.postgres.CanonicalSchemaInitializer;
import com.quizbackend.web.error.ApiException;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.postgresql.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * PostgreSQL/Testcontainers hardening slice.
 *
 * <p>Proves {@link QuizEntity}/{@link QuizRepository}/{@link QuizService}
 * against a REAL, disposable PostgreSQL database running the EXACT canonical
 * schema ({@code backend/src/db/migrations/*.sql}, applied via
 * {@link CanonicalSchemaInitializer}) &mdash; not Neon, and not H2. This is
 * the layer the previous Slice 2 report flagged as missing: ordinary
 * {@code mvnw.cmd test} proves controller/DTO/policy behavior with a mocked
 * repository, and the real-Neon smoke test proves connectivity, but neither
 * proves Hibernate's mapping is actually valid against genuine PostgreSQL
 * DDL (identity columns, generated STORED columns, CHECK constraints) with a
 * real query executing against it.
 *
 * <p><b>*IT suffix, Failsafe-bound, NOT Surefire-bound</b>: this class only
 * runs on an explicit {@code mvnw.cmd verify} (or {@code failsafe:integration
 * -test}), never on {@code mvnw.cmd test} or {@code mvnw.cmd clean package}.
 * If Docker is unavailable, container startup throws during
 * {@code @Testcontainers}' {@code beforeAll} handling and every test in this
 * class fails loudly &mdash; there is no fallback path that could report a
 * false pass.
 *
 * <p>No {@code @ActiveProfiles} is set: the DEFAULT profile is used (the one
 * with real {@code spring.jpa.hibernate.ddl-auto=validate} and no JPA
 * autoconfiguration exclusion), and {@link #datasourceProperties} overrides
 * {@code spring.datasource.*} with the container's real, concrete JDBC URL —
 * this takes priority over (and never attempts to resolve) the base
 * profile's {@code ${SPRING_DATASOURCE_URL}} placeholder, so no Neon
 * environment variable is required to run this suite. Never targets Neon:
 * nothing in this class or {@link CanonicalSchemaInitializer} references it.
 */
@Testcontainers
@SpringBootTest
class QuizRepositoryPostgresIT {

    @Container
    static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer("postgres:18-alpine");

    @DynamicPropertySource
    static void datasourceProperties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        registry.add("spring.datasource.username", POSTGRES::getUsername);
        registry.add("spring.datasource.password", POSTGRES::getPassword);
        // This class deliberately runs under the DEFAULT profile (real
        // ddl-auto=validate, real datasource autoconfiguration) rather than
        // @ActiveProfiles("test"), so it never sees application-test
        // .properties' synthetic override — TopicQuizReceiptSecret's real,
        // fail-closed constructor otherwise refuses to start without a real
        // TOPIC_QUIZ_RECEIPT_SECRET. Supplying an obviously-synthetic value
        // here (satisfying only the length check, never a real secret) keeps
        // that fail-closed behavior fully intact while letting the context load.
        registry.add("topicquiz.receipt-secret", () -> "test-only-synthetic-topic-quiz-receipt-secret");
    }

    // Synthetic quiz-id -> internal PK, resolved once seeding has run so
    // tests can look up aggregate-count results by the same key the
    // production native query groups by.
    private static Long alphaPk;
    private static Long betaPk;
    private static Long malformedFactsPk;

    /**
     * Runs once, before the Spring context is created (JUnit5 guarantees
     * {@code @Testcontainers}' container startup, then this class's own
     * {@code @BeforeAll}, both precede {@code SpringExtension}'s
     * per-test-instance context creation): apply the canonical schema, then
     * seed a small synthetic dataset via plain JDBC. No production write API
     * is used or added — the application itself remains read-only; this is
     * test setup using the database directly, exactly like the Node
     * reference's own migration/import tooling does outside the API.
     */
    @BeforeAll
    static void applySchemaAndSeedSyntheticData() throws SQLException {
        CanonicalSchemaInitializer.applyTo(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());

        try (Connection connection = DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())) {

            // test-beta: lowest display_order (5) among the ACTIVE quizzes,
            // so an ordering test that only checked insertion order would
            // pass by accident — this makes it fail unless display_order is
            // genuinely honored. Null difficulty proves the nullable-column
            // round-trip; facts_json is the canonical schema's own
            // NOT-NULL-DEFAULT-'[]' empty case (an explicit SQL NULL here
            // would violate the real `facts_json TEXT NOT NULL DEFAULT '[]'`
            // constraint, which only Postgres — not a mock — actually enforces).
            insertQuiz(connection, "test-beta", "Test Beta", "", "", null, "[]", 5, "active");

            // test-alpha: higher display_order (10) than test-beta, valid
            // facts array, non-null difficulty. Gets 3 synthetic questions.
            alphaPk = insertQuiz(connection, "test-alpha", "Test Alpha", "Synthetic alpha quiz.", "",
                    "beginner", "[\"Fact A1\",\"Fact A2\"]", 10, "active");

            // test-retired: the LOWEST display_order of all three (1) but
            // status='retired' — if the active-list query ever forgot its
            // WHERE clause, this quiz would sort FIRST, making the omission
            // obvious rather than silently correct-by-luck.
            Long retiredPk = insertQuiz(connection, "test-retired", "Test Retired", "", "",
                    "advanced", "[]", 1, "retired");

            // test-malformed-facts: valid JSON but not a string array —
            // proves parseFacts()'s malformed-input handling end-to-end
            // (Postgres -> entity -> service), not just at the unit level.
            malformedFactsPk = insertQuiz(connection, "test-malformed-facts", "Test Malformed Facts", "", "",
                    null, "{\"not\":\"an array\"}", 20, "active");

            betaPk = idOf(connection, "test-beta");

            insertQuestion(connection, alphaPk, "Synthetic alpha question 1?", "single", "Because.", 0);
            insertQuestion(connection, alphaPk, "Synthetic alpha question 2?", "multiple", "Because.", 1);
            insertQuestion(connection, alphaPk, "Synthetic alpha question 3?", "trueFalse", "Because.", 2);

            // A retired quiz's OWN question — proves the aggregate count
            // query does not leak rows across quizzes even when they exist
            // in the same table; test-retired is never in the active list at
            // all, so this row must never be visible through any assertion.
            insertQuestion(connection, retiredPk, "Synthetic retired question?", "single", "Because.", 0);
            // test-beta and test-malformed-facts deliberately get ZERO
            // questions — the zero-question / no-bleed case.
        }
    }

    private static Long insertQuiz(Connection connection, String quizId, String milestone, String summary,
            String image, String difficulty, String factsJson, int displayOrder, String status) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(
                "INSERT INTO quizzes (quiz_id, milestone, summary, image, difficulty, facts_json, display_order, status) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?)")) {
            statement.setString(1, quizId);
            statement.setString(2, milestone);
            statement.setString(3, summary);
            statement.setString(4, image);
            statement.setString(5, difficulty);
            statement.setString(6, factsJson);
            statement.setInt(7, displayOrder);
            statement.setString(8, status);
            statement.executeUpdate();
        }
        return idOf(connection, quizId);
    }

    private static Long idOf(Connection connection, String quizId) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement("SELECT id FROM quizzes WHERE quiz_id = ?")) {
            statement.setString(1, quizId);
            var resultSet = statement.executeQuery();
            resultSet.next();
            return resultSet.getLong("id");
        }
    }

    private static void insertQuestion(Connection connection, long quizPk, String questionText, String questionType,
            String explanation, int displayOrder) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(
                "INSERT INTO questions (quiz_pk, question_text, question_type, explanation, display_order) "
                        + "VALUES (?, ?, ?, ?, ?)")) {
            statement.setLong(1, quizPk);
            statement.setString(2, questionText);
            statement.setString(3, questionType);
            statement.setString(4, explanation);
            statement.setInt(5, displayOrder);
            statement.executeUpdate();
        }
    }

    @Autowired
    private QuizRepository quizRepository;

    @Autowired
    private QuizService quizService;

    // ── A. Active ordering ──────────────────────────────────────────────

    @Test
    void activeListIsOrderedByDisplayOrderNotInsertionOrRetiredPosition() {
        List<QuizEntity> active = quizRepository.findByStatusOrderByDisplayOrder("active");

        assertThat(active).extracting(QuizEntity::getQuizId)
                .containsExactly("test-beta", "test-alpha", "test-malformed-facts");
    }

    // ── B. Retired filtering ────────────────────────────────────────────

    @Test
    void retiredQuizIsAbsentFromTheActiveList() {
        List<QuizEntity> active = quizRepository.findByStatusOrderByDisplayOrder("active");

        assertThat(active).extracting(QuizEntity::getQuizId).doesNotContain("test-retired");
    }

    @Test
    void retiredQuizLookupByActiveStatusIsEmptyMatchingTheProductionNotFoundPath() {
        Optional<QuizEntity> lookup = quizRepository.findByQuizIdAndStatus("test-retired", "active");

        assertThat(lookup).isEmpty();
    }

    // ── C. Public quiz_id lookup (never the internal id) ────────────────

    @Test
    void lookupByPublicQuizIdReturnsTheExpectedEntity() {
        Optional<QuizEntity> found = quizRepository.findByQuizIdAndStatus("test-alpha", "active");

        assertThat(found).isPresent();
        assertThat(found.get().getQuizId()).isEqualTo("test-alpha");
        assertThat(found.get().getMilestone()).isEqualTo("Test Alpha");
        // The internal identity column exists and is populated (proves the
        // GENERATED ALWAYS AS IDENTITY mapping works), but is never what a
        // caller looks up by — quiz_id is.
        assertThat(found.get().getId()).isNotNull();
    }

    // ── D. Question-count aggregation, no bleed ──────────────────────────

    @Test
    void aggregateQuestionCountsAreCorrectPerQuizWithNoBleedAcrossQuizzes() {
        List<QuizRepository.QuestionCountProjection> counts =
                quizRepository.countQuestionsByQuizPks(List.of(alphaPk, betaPk, malformedFactsPk));

        assertThat(counts).hasSize(1); // only alpha has any question rows at all
        assertThat(counts.get(0).getQuizPk()).isEqualTo(alphaPk);
        assertThat(counts.get(0).getQuestionCount()).isEqualTo(3L);
    }

    // ── E. PostgreSQL mapping via the service layer ─────────────────────

    @Test
    void serviceListReturnsCorrectCountsIncludingZeroForQuizzesWithNoQuestions() {
        List<QuizMetadataDto> metadata = quizService.listQuizMetadata();

        assertThat(metadata).extracting(QuizMetadataDto::quizId)
                .containsExactly("test-beta", "test-alpha", "test-malformed-facts");
        assertThat(metadata.get(0).questionCount()).as("test-beta: zero questions").isZero();
        assertThat(metadata.get(1).questionCount()).as("test-alpha: three questions").isEqualTo(3L);
        assertThat(metadata.get(2).questionCount()).as("test-malformed-facts: zero questions").isZero();
    }

    @Test
    void nullDifficultyAndCanonicalEmptyFactsJsonSurviveThePostgresRoundTrip() {
        QuizMetadataDto beta = quizService.getQuizMetadata("test-beta");

        assertThat(beta.difficulty()).isNull();
        assertThat(beta.facts()).isEmpty();
    }

    @Test
    void validFactsJsonArraySurvivesThePostgresRoundTrip() {
        QuizMetadataDto alpha = quizService.getQuizMetadata("test-alpha");

        assertThat(alpha.facts()).containsExactly("Fact A1", "Fact A2");
    }

    @Test
    void malformedNonArrayFactsJsonYieldsAnEmptyListEndToEnd() {
        QuizMetadataDto malformed = quizService.getQuizMetadata("test-malformed-facts");

        assertThat(malformed.facts()).isEmpty();
    }

    @Test
    void retiredQuizLookupThroughTheServiceThrowsNotFound() {
        assertThatThrownBy(() -> quizService.getQuizMetadata("test-retired"))
                .isInstanceOf(ApiException.class)
                .satisfies(ex -> assertThat(((ApiException) ex).getCode()).isEqualTo("NOT_FOUND"));
    }
}
