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
        return new CreateSessionInput(sessionId, "token-hash-" + sessionId, attemptId, config, 1200, NOW, EXPIRES, questions, null, null);
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
                new CreateSessionInput("is_rollback", "token-hash-rollback", "ia_rollback", config, 1200, NOW, EXPIRES, questions, null, null)))
                .isInstanceOf(DataAccessException.class);

        Integer sessionRows = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM interview_sessions WHERE id = ?", Integer.class, "is_rollback");
        assertThat(sessionRows).isZero();
        assertThat(countRows("session_questions", "is_rollback")).isEqualTo(0);
        assertThat(countRows("session_options", "is_rollback")).isEqualTo(0);
    }

    // ── Idempotency (Idempotency-Key) — REAL Postgres proof ─────────────
    //
    // The service-layer orchestration (hash validation, BAD_REQUEST/CONFLICT
    // translation) is proven with a mocked repository in
    // InterviewSessionServiceTest; these tests prove the one thing only a
    // real database can prove: the UNIQUE constraint genuinely serializes
    // concurrent writers, and mintAdditionalToken genuinely persists an
    // ADDITIONAL row without ever touching the original token_hash column.

    /**
     * A realistic-shaped (64 hex chars) fake hash — the DB's own CHECK
     * constraints on BOTH idempotency_key_hash and idempotency_request_hash
     * enforce exactly this length, since production only ever writes a real
     * SHA-256 hex digest to either column, never a raw client value.
     */
    private static String fakeHash(String seed) {
        return String.format("%-64s", seed).replace(' ', '0');
    }

    private CreateSessionInput inputWithKey(String sessionId, String attemptId, String idempotencyKeyHash, String requestHash) {
        List<GeneratedQuestionSnapshot> questions = List.of(new GeneratedQuestionSnapshot(
                0, sessionId + ":q:0", "synthetic-topic", "Question?", "single", "Because.",
                List.of(new GeneratedOptionSnapshot(101, "Correct", 0, true), new GeneratedOptionSnapshot(102, "Wrong", 1, false)),
                null));
        InterviewSessionConfig config = new InterviewSessionConfig("mixed", List.of("synthetic-topic"), 1, null, null);
        return new CreateSessionInput(sessionId, "token-hash-" + sessionId, attemptId, config, 1200, NOW, EXPIRES, questions,
                idempotencyKeyHash, requestHash);
    }

    /**
     * Simulates "the first request committed, but its HTTP response was lost
     * (a Render 504 during a Spring/Neon cold start) — the client retries
     * with the SAME key." The retry must find the already-committed session,
     * never insert a second one, and mintAdditionalToken must genuinely
     * persist a fresh, usable credential WITHOUT touching the original
     * token_hash column — the lost response may, in fact, still arrive at a
     * live caller (an ambiguous failure is ambiguous both ways), so that
     * original credential must keep working too.
     */
    @Test
    void retryAfterALostResponseFindsTheOriginalSessionAndMintsAnAdditionalUsableToken() {
        repository.createSessionSnapshot(inputWithKey("is_lost_response", "ia_lost_response", fakeHash("idem-lost-response"), fakeHash("abc")));

        InterviewSessionRepository.IdempotencyLookup found =
                repository.findByIdempotencyKeyHash(fakeHash("idem-lost-response")).orElseThrow();
        assertThat(found.sessionId()).isEqualTo("is_lost_response");
        assertThat(found.requestHash()).isEqualTo(fakeHash("abc"));
        assertThat(found.createdAt()).isEqualTo(NOW);

        String tokenHashBefore = jdbcTemplate.queryForObject(
                "SELECT token_hash FROM interview_sessions WHERE id = ?", String.class, "is_lost_response");

        SessionToken.TokenPair extra = repository.mintAdditionalToken("is_lost_response", NOW);

        String tokenHashAfter = jdbcTemplate.queryForObject(
                "SELECT token_hash FROM interview_sessions WHERE id = ?", String.class, "is_lost_response");
        // The ORIGINAL credential — the one the "lost" response actually
        // carried — is untouched: if that response turns out not to have
        // been lost after all, it is still good.
        assertThat(tokenHashAfter).isEqualTo(tokenHashBefore);
        // The NEW credential — for the retry that assumed it WAS lost —
        // independently verifies via the extra-tokens table.
        assertThat(repository.hasExtraToken("is_lost_response", extra.tokenHash())).isTrue();

        // Still exactly ONE session for this key — minting a token never inserts a session row.
        Integer countForKey = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM interview_sessions WHERE idempotency_key_hash = ?", Integer.class, fakeHash("idem-lost-response"));
        assertThat(countForKey).isEqualTo(1);
        assertThat(countRows("session_questions", "is_lost_response")).isEqualTo(1);
    }

    /**
     * The property "every successful response returned during concurrent
     * duplicate creation remains usable", proven directly against real
     * Postgres: THREE independently-obtained credentials for the SAME
     * session (the original, plus two minted for two different "losing"
     * callers) must ALL still verify — minting the second must not have
     * invalidated the first, and neither may have touched the original.
     */
    @Test
    void mintingMultipleAdditionalTokensNeverInvalidatesAnyEarlierCredential() {
        repository.createSessionSnapshot(inputWithKey("is_multi_racer", "ia_multi_racer", fakeHash("multi-key"), fakeHash("multi")));
        String originalHash = jdbcTemplate.queryForObject(
                "SELECT token_hash FROM interview_sessions WHERE id = ?", String.class, "is_multi_racer");

        SessionToken.TokenPair first = repository.mintAdditionalToken("is_multi_racer", NOW);
        SessionToken.TokenPair second = repository.mintAdditionalToken("is_multi_racer", NOW + 1);

        String hashAfterBoth = jdbcTemplate.queryForObject(
                "SELECT token_hash FROM interview_sessions WHERE id = ?", String.class, "is_multi_racer");
        assertThat(hashAfterBoth).isEqualTo(originalHash);
        assertThat(repository.hasExtraToken("is_multi_racer", first.tokenHash())).isTrue();
        assertThat(repository.hasExtraToken("is_multi_racer", second.tokenHash())).isTrue();
        assertThat(first.tokenHash()).isNotEqualTo(second.tokenHash());
    }

    /** PostgreSQL's own UNIQUE constraint is the real arbiter — a second session id cannot reuse a committed key. */
    @Test
    void theDatabaseUniqueConstraintRejectsASecondSessionUnderAnAlreadyCommittedKey() {
        repository.createSessionSnapshot(inputWithKey("is_first_owner", "ia_first_owner", fakeHash("shared-key"), fakeHash("xyz")));

        assertThatThrownBy(() -> repository.createSessionSnapshot(
                inputWithKey("is_second_claimant", "ia_second_claimant", fakeHash("shared-key"), fakeHash("xyz"))))
                .isInstanceOf(SessionRepositoryException.class)
                .satisfies(ex -> assertThat(((SessionRepositoryException) ex).getCategory())
                        .isEqualTo(SessionRepositoryException.Category.IDEMPOTENCY_KEY_RACE));

        Integer countForKey = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM interview_sessions WHERE idempotency_key_hash = ?", Integer.class, fakeHash("shared-key"));
        assertThat(countForKey).isEqualTo(1);
        // The loser's session id was never committed — genuinely rolled back, not just rejected after a partial write.
        Integer loserRows = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM interview_sessions WHERE id = ?", Integer.class, "is_second_claimant");
        assertThat(loserRows).isZero();
    }

    /**
     * TWO genuinely concurrent inserts racing for the SAME key — the
     * requirement this whole mechanism exists to satisfy ("concurrent
     * duplicate requests must converge on one session"). Exactly one thread
     * must win; the other must fail with IDEMPOTENCY_KEY_RACE, never with an
     * unrelated/unexpected error, and never by silently creating a second row.
     */
    @Test
    void concurrentInsertsWithTheSameKeyConvergeOnExactlyOneSessionRow() {
        CompletableFuture<Object> a = CompletableFuture.supplyAsync(() -> {
            try {
                return (Object) repository.createSessionSnapshot(inputWithKey("is_race_a", "ia_race_a", fakeHash("race-key"), fakeHash("race")));
            } catch (SessionRepositoryException e) {
                return (Object) e;
            }
        });
        CompletableFuture<Object> b = CompletableFuture.supplyAsync(() -> {
            try {
                return (Object) repository.createSessionSnapshot(inputWithKey("is_race_b", "ia_race_b", fakeHash("race-key"), fakeHash("race")));
            } catch (SessionRepositoryException e) {
                return (Object) e;
            }
        });

        Object resultA = a.join();
        Object resultB = b.join();

        // Exactly one of the two outcomes is a success, the other is the race exception.
        long successes = List.of(resultA, resultB).stream().filter(r -> r instanceof InterviewSessionRecord).count();
        long raceFailures = List.of(resultA, resultB).stream()
                .filter(r -> r instanceof SessionRepositoryException e && e.getCategory() == SessionRepositoryException.Category.IDEMPOTENCY_KEY_RACE)
                .count();
        assertThat(successes).isEqualTo(1);
        assertThat(raceFailures).isEqualTo(1);

        Integer countForKey = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM interview_sessions WHERE idempotency_key_hash = ?", Integer.class, fakeHash("race-key"));
        assertThat(countForKey).isEqualTo(1);

        // Both racers were genuinely live callers each awaiting their own
        // response — the winner already holds a working token (from its own
        // 201); the loser resolves via the SAME recovery path the service
        // uses (mintAdditionalToken). Proving BOTH remain valid afterward is
        // the whole point of this mechanism: neither response may go stale.
        InterviewSessionRecord winner = (InterviewSessionRecord) (resultA instanceof InterviewSessionRecord ? resultA : resultB);
        String winnerOriginalHash = jdbcTemplate.queryForObject(
                "SELECT token_hash FROM interview_sessions WHERE id = ?", String.class, winner.id());
        assertThat(winnerOriginalHash).isEqualTo(winner.tokenHash());

        SessionToken.TokenPair loserToken = repository.mintAdditionalToken(winner.id(), NOW);

        String winnerHashAfterLoserMinted = jdbcTemplate.queryForObject(
                "SELECT token_hash FROM interview_sessions WHERE id = ?", String.class, winner.id());
        assertThat(winnerHashAfterLoserMinted).isEqualTo(winnerOriginalHash); // the winner's own response is still good
        assertThat(repository.hasExtraToken(winner.id(), loserToken.tokenHash())).isTrue(); // and so is the loser's
    }

    /**
     * {@code InterviewSessionService}'s REPLAY_WINDOW_MS check (proven in
     * isolation, with a mocked repository, in {@code InterviewSessionServiceTest})
     * reads {@code created_at} straight off this lookup — this proves THAT
     * value genuinely round-trips through real Postgres unchanged, including
     * after it is altered out from under a long-lived row (simulating time
     * having passed), which is the one thing a mocked repository cannot prove.
     */
    @Test
    void findByIdempotencyKeyHashReturnsTheRealPersistedCreationTimeEvenLongAfterInsert() {
        repository.createSessionSnapshot(inputWithKey("is_aged", "ia_aged", fakeHash("aged-key"), fakeHash("aged")));
        assertThat(repository.findByIdempotencyKeyHash(fakeHash("aged-key")).orElseThrow().createdAt()).isEqualTo(NOW);

        long muchEarlier = NOW - (60 * 60_000L); // 1 hour before insert — simulates a long-since-expired key
        jdbcTemplate.update("UPDATE interview_sessions SET created_at = ? WHERE id = ?", muchEarlier, "is_aged");

        assertThat(repository.findByIdempotencyKeyHash(fakeHash("aged-key")).orElseThrow().createdAt()).isEqualTo(muchEarlier);
    }

    /** {@code countExtraTokens} — the query {@code InterviewSessionService}'s MAX_EXTRA_TOKENS_PER_SESSION cap reads — genuinely reflects rows minted so far. */
    @Test
    void countExtraTokensReflectsExactlyHowManyHaveBeenMintedForThisSession() {
        repository.createSessionSnapshot(inputWithKey("is_counted", "ia_counted", fakeHash("counted-key"), fakeHash("counted")));
        assertThat(repository.countExtraTokens("is_counted")).isZero();

        repository.mintAdditionalToken("is_counted", NOW);
        assertThat(repository.countExtraTokens("is_counted")).isEqualTo(1);

        repository.mintAdditionalToken("is_counted", NOW + 1);
        repository.mintAdditionalToken("is_counted", NOW + 2);
        assertThat(repository.countExtraTokens("is_counted")).isEqualTo(3);

        // Scoped by session — a DIFFERENT session's minted tokens never count against this one.
        repository.createSessionSnapshot(inputWithKey("is_unrelated", "ia_unrelated", fakeHash("unrelated-key"), fakeHash("unrelated")));
        repository.mintAdditionalToken("is_unrelated", NOW);
        assertThat(repository.countExtraTokens("is_counted")).isEqualTo(3);
    }

    /**
     * CLEANUP/CASCADE: deleting a session row must take its extra tokens with
     * it — interview_session_extra_tokens has no independent lifetime of its
     * own (see migration 008's own doc comment). Proven against real
     * Postgres rather than assumed from the schema text, since {@code ON
     * DELETE CASCADE} is exactly the kind of clause a later migration could
     * silently drop without any application code noticing.
     */
    @Test
    void deletingASessionCascadesToRemoveItsExtraTokens() {
        repository.createSessionSnapshot(inputWithKey("is_to_delete", "ia_to_delete", fakeHash("delete-key"), fakeHash("delete")));
        repository.mintAdditionalToken("is_to_delete", NOW);
        repository.mintAdditionalToken("is_to_delete", NOW + 1);
        assertThat(repository.countExtraTokens("is_to_delete")).isEqualTo(2);

        jdbcTemplate.update("DELETE FROM interview_sessions WHERE id = ?", "is_to_delete");

        Integer remaining = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM interview_session_extra_tokens WHERE session_id = ?", Integer.class, "is_to_delete");
        assertThat(remaining).isZero();
    }
}
