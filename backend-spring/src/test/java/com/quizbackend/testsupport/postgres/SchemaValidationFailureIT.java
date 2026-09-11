package com.quizbackend.testsupport.postgres;

import com.quizbackend.QuizBackendApplication;
import org.junit.jupiter.api.Test;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.testcontainers.postgresql.PostgreSQLContainer;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;

import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Proves the two fail-closed startup behaviors the Phase 1 production-
 * readiness audit flagged as architecturally guaranteed by
 * {@code spring.jpa.hibernate.ddl-auto=validate} but not exercised by any
 * existing test: an EMPTY database, and a database with only SOME
 * migrations applied (schema mismatch), must both refuse to let the
 * application finish starting — never silently boot against a schema the
 * entity mappings don't actually match.
 *
 * <p>Each test gets its OWN disposable, freshly-created container (not the
 * shared static one other *IT classes use) so this class has full control
 * over exactly how much schema exists before the context boot is attempted.
 * Never touches Neon — {@link PostgreSQLContainer} instances here are
 * exactly as ephemeral and local as every other *IT class's.
 *
 * <p>The context is booted via {@link SpringApplicationBuilder} directly
 * (not {@code @SpringBootTest}), so a startup failure surfaces as a normal
 * Java exception this test can assert on, rather than as a JUnit test
 * failure indistinguishable from "the test itself is broken."
 */
class SchemaValidationFailureIT {

    private static final String RECEIPT_SECRET = "test-only-synthetic-topic-quiz-receipt-secret";

    @Test
    void anEmptyDatabaseWithNoMigrationsAppliedFailsToStartRatherThanBootingSilently() {
        try (PostgreSQLContainer postgres = new PostgreSQLContainer("postgres:18-alpine")) {
            postgres.start();
            try {
                // Deliberately apply NOTHING — the container's default 'test'
                // database has no tables at all.
                assertThatThrownBy(() -> bootAgainst(postgres))
                        .as("Spring must refuse to start against a completely unmigrated database")
                        .isNotNull();
            } finally {
                postgres.stop();
            }
        }
    }

    @Test
    void aPartiallyMigratedDatabaseMissingLaterTablesFailsToStartRatherThanBootingSilently()
            throws SQLException {
        try (PostgreSQLContainer postgres = new PostgreSQLContainer("postgres:18-alpine")) {
            postgres.start();
            try {
                // Apply ONLY migration 001 (interview_sessions) — the
                // quizzes/questions tables QuizEntity maps to never get
                // created. This is "schema mismatch": some migrations ran,
                // just not all of them — a realistic snapshot of Spring
                // booting before Node has finished catching the schema up,
                // not merely "nothing was ever applied".
                applyOnlyFirstMigration(postgres);

                assertThatThrownBy(() -> bootAgainst(postgres))
                        .as("Spring must refuse to start when its entity mappings do not match the actual schema")
                        .isNotNull();
            } finally {
                postgres.stop();
            }
        }
    }

    private static void bootAgainst(PostgreSQLContainer postgres) {
        // Passed as command-line args (not .properties(), which binds as
        // Spring's lowest-precedence "defaultProperties" source) so these
        // values actually win over the packaged application.properties'
        // ${SPRING_DATASOURCE_URL}-style placeholders.
        try (var context = new SpringApplicationBuilder(QuizBackendApplication.class)
                .web(org.springframework.boot.WebApplicationType.SERVLET)
                .run(
                        "--spring.datasource.url=" + postgres.getJdbcUrl(),
                        "--spring.datasource.username=" + postgres.getUsername(),
                        "--spring.datasource.password=" + postgres.getPassword(),
                        "--topicquiz.receipt-secret=" + RECEIPT_SECRET,
                        // Random free port — this context is never actually
                        // used to serve a request, it either fails during
                        // startup (the thing under test) or is closed
                        // immediately in the try-with-resources below.
                        "--server.port=0")) {
            // Reached only if startup unexpectedly SUCCEEDED — close it so
            // the assertion failure message is the only thing left behind,
            // not a leaked context.
        }
    }

    /** Applies ONLY the lowest-numbered canonical migration file, by the same ordering CanonicalSchemaInitializer uses. */
    private static void applyOnlyFirstMigration(PostgreSQLContainer postgres) throws SQLException {
        Path directory = CanonicalSchemaInitializer.migrationsDirectory();
        Path first;
        try (var entries = Files.list(directory)) {
            first = entries
                    .filter(p -> p.getFileName().toString().matches("^\\d{3,}_.*\\.sql$"))
                    .min((a, b) -> a.getFileName().toString().compareTo(b.getFileName().toString()))
                    .orElseThrow(() -> new IllegalStateException("No canonical migrations found in " + directory));
        } catch (java.io.IOException e) {
            throw new java.io.UncheckedIOException(e);
        }

        try (Connection connection = DriverManager.getConnection(
                postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword());
                Statement statement = connection.createStatement()) {
            statement.execute(Files.readString(first));
        } catch (java.io.IOException e) {
            throw new java.io.UncheckedIOException(e);
        }
    }
}
