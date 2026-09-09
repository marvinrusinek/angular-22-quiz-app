package com.quizbackend.testsupport.postgres;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.Comparator;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * Applies the EXISTING canonical Node/PostgreSQL migrations
 * ({@code backend/src/db/migrations/*.sql}) to a disposable Testcontainers
 * PostgreSQL database, so integration tests validate against the real
 * application schema rather than a hand-written parallel one.
 *
 * <p>Deliberately test-only (lives under {@code src/test}, never reaches the
 * production JAR) and deliberately reads the canonical files rather than
 * copying them: two independently-maintained schema definitions could drift,
 * and this migration mirror already applies field-by-field discipline
 * elsewhere for exactly that reason.
 *
 * <p>The naming/ordering rules are a direct port of the Node reference's
 * {@code listMigrationFiles} ({@code backend/src/db/migrate.ts}) &mdash; same
 * filename pattern, same numeric (not lexicographic) ordering &mdash; so a
 * file that Node would refuse to apply is refused here too, rather than being
 * silently accepted by a looser check.
 *
 * <p>Each file's full contents are sent to PostgreSQL as ONE
 * {@link Statement#execute(String)} call. This relies on PostgreSQL's simple
 * query protocol, which natively executes a semicolon-separated batch of
 * statements sequentially and aborts the batch (throwing) on the first
 * failure &mdash; there is no manual statement-splitting here, and no
 * swallowed exception path. A failure anywhere in a migration file fails this
 * method loudly; nothing is applied silently or partially reported as
 * success.
 */
public final class CanonicalSchemaInitializer {

    private static final Pattern FILENAME_PATTERN = Pattern.compile("^(\\d{3,})_([A-Za-z0-9_-]+)\\.sql$");

    private CanonicalSchemaInitializer() {
    }

    /**
     * Applies every canonical migration, in order, to the given database.
     * Callers are responsible for pointing {@code jdbcUrl} at a disposable
     * database (a Testcontainer) &mdash; this class has no knowledge of Neon
     * and no code path that could reach it; it only ever does what the
     * caller's connection parameters tell it to.
     */
    public static void applyTo(String jdbcUrl, String username, String password) {
        List<Path> files = listMigrationFilesInOrder(migrationsDirectory());
        try (Connection connection = DriverManager.getConnection(jdbcUrl, username, password);
                Statement statement = connection.createStatement()) {
            for (Path file : files) {
                String sql;
                try {
                    sql = Files.readString(file);
                } catch (IOException e) {
                    throw new IllegalStateException(
                            "Canonical migration could not be read: " + file, e);
                }
                try {
                    statement.execute(sql);
                } catch (SQLException e) {
                    throw new IllegalStateException(
                            "Canonical migration failed to apply: " + file.getFileName()
                                    + " (SQLSTATE " + e.getSQLState() + ")", e);
                }
            }
        } catch (SQLException e) {
            throw new IllegalStateException(
                    "Could not connect to the Testcontainers PostgreSQL database at " + jdbcUrl, e);
        }
    }

    /**
     * The canonical migrations directory, resolved RELATIVE to the JVM
     * working directory at test time. Maven Surefire/Failsafe fork test JVMs
     * with a working directory of {@code ${project.basedir}} by default
     * &mdash; i.e. {@code backend-spring/} &mdash; which is also the
     * directory every {@code mvnw.cmd} command in this project's documented
     * workflow is invoked from. {@code backend/} is its sibling under the
     * repository root, so this relative path is stable for any checkout of
     * this repository, not tied to one developer's machine.
     */
    static Path migrationsDirectory() {
        Path directory = Path.of("..", "backend", "src", "db", "migrations").normalize().toAbsolutePath();
        if (!Files.isDirectory(directory)) {
            throw new IllegalStateException(
                    "Canonical migrations directory not found at " + directory
                            + " — PostgreSQL integration tests must be run with backend-spring/ as the "
                            + "working directory (the standard `cd backend-spring && mvnw.cmd verify` "
                            + "invocation used throughout this project), with the sibling backend/ "
                            + "directory present.");
        }
        return directory;
    }

    private static List<Path> listMigrationFilesInOrder(Path directory) {
        try (Stream<Path> entries = Files.list(directory)) {
            List<Path> files = entries
                    .filter(path -> path.getFileName().toString().endsWith(".sql"))
                    .sorted(Comparator.comparingInt(path -> versionOf(path.getFileName().toString())))
                    .toList();
            if (files.isEmpty()) {
                throw new IllegalStateException("No canonical migrations found in " + directory);
            }
            return files;
        } catch (IOException e) {
            throw new UncheckedIOException("Could not list canonical migrations directory: " + directory, e);
        }
    }

    private static int versionOf(String fileName) {
        Matcher matcher = FILENAME_PATTERN.matcher(fileName);
        if (!matcher.matches()) {
            throw new IllegalStateException(
                    "Migration file name must look like 001_description.sql — found \"" + fileName + "\"");
        }
        return Integer.parseInt(matcher.group(1));
    }
}
