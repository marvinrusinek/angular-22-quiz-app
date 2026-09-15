package com.quizbackend.interview;

import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.mockito.ArgumentCaptor;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import tools.jackson.databind.json.JsonMapper;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoMoreInteractions;
import static org.mockito.Mockito.when;

/**
 * PERFORMANCE REGRESSION: proves {@link InterviewSessionRepository#createSessionSnapshot}
 * issues a FIXED, N-INDEPENDENT number of JDBC calls for its writes — one
 * {@code update} (the session row) plus exactly ONE {@code batchUpdate} each
 * for questions and options, regardless of question count. Before the
 * batching fix this scaled as 1 + N + 2N individual, sequential {@code update}
 * calls, each one blocking on its own request/response before the next
 * began; a regression back to that shape would silently reappear as a wall-clock
 * slowdown against any real (non-loopback) database — confirmed against a
 * real local Spring instance talking to Neon: session creation dropped from
 * 11.99s to 7.82s (15 questions) and 15.89s to 5.94s (25 questions) after
 * this fix. This test asserts the fixed JDBC-CALL count directly; it makes
 * no claim about the number of physical TCP round trips those calls turn
 * into on the wire, which depends on pgJDBC's own batching/protocol
 * behavior and was not captured here.
 *
 * <p>Uses a MOCKED {@link JdbcTemplate} rather than a real database
 * deliberately: call-count assertions need to be independent of any
 * database's actual latency, and this makes the proof a fast, deterministic
 * unit test instead of a timing-sensitive integration one. The genuine-SQL,
 * genuine-Postgres proof of correctness (row content, order, rollback) lives
 * in {@code InterviewSessionCreatePostgresIT}.
 */
class InterviewSessionRepositoryBatchingTest {

    private static CreateSessionInput inputWithQuestions(int questionCount) {
        List<GeneratedQuestionSnapshot> questions = new ArrayList<>(questionCount);
        for (int i = 0; i < questionCount; i++) {
            questions.add(new GeneratedQuestionSnapshot(
                    i, "q:" + i, "topic", "Question " + i + "?", "single", "Because.",
                    List.of(new GeneratedOptionSnapshot(i * 2 + 1, "A", 0, true),
                            new GeneratedOptionSnapshot(i * 2 + 2, "B", 1, false)),
                    null));
        }
        InterviewSessionConfig config = new InterviewSessionConfig("mixed", List.of("topic"), questionCount, null, null);
        return new CreateSessionInput("is_test", "hash", "ia_test", config, 1200, 1000L, 2000L, questions, null, null);
    }

    @ParameterizedTest
    @ValueSource(ints = {15, 20, 25})
    void writesUseExactlyOneUpdateAndTwoBatchUpdatesRegardlessOfQuestionCount(int questionCount) {
        JdbcTemplate jdbcTemplate = mock(JdbcTemplate.class);
        PlatformTransactionManager transactionManager = mock(PlatformTransactionManager.class);
        InterviewSessionRepository repository =
                new InterviewSessionRepository(jdbcTemplate, JsonMapper.builder().build(), transactionManager);

        // Mockito's default for an unstubbed int-returning method is 0, which
        // this repository now reads as "ON CONFLICT DO NOTHING skipped the
        // insert" (see INSERT_SESSION's own doc comment) — stub a genuine
        // 1-row insert so this test exercises the ordinary success path.
        when(jdbcTemplate.update(anyString(), any(), any(), any(), any(), any(), any(), any(), any(), any())).thenReturn(1);

        repository.createSessionSnapshot(inputWithQuestions(questionCount));

        // Exactly one JDBC call for the session row itself (7 columns + the
        // idempotency key/hash pair added for cold-start-safe retries)...
        verify(jdbcTemplate, times(1)).update(anyString(), any(), any(), any(), any(), any(), any(), any(), any(), any());

        // ...and exactly TWO batchUpdate calls total (questions, then options)
        // — never N individual question inserts or 2N individual option
        // inserts. Captured together so each batch's row COUNT can also be
        // checked against the real question/option totals.
        @SuppressWarnings("unchecked")
        ArgumentCaptor<List<Object[]>> batchCaptor = ArgumentCaptor.forClass(List.class);
        verify(jdbcTemplate, times(2)).batchUpdate(anyString(), batchCaptor.capture());
        List<List<Object[]>> batches = batchCaptor.getAllValues();
        assertThat(batches).hasSize(2);
        assertThat(batches.get(0)).as("question batch").hasSize(questionCount);
        assertThat(batches.get(1)).as("option batch (2 options per question)").hasSize(questionCount * 2);

        verifyNoMoreInteractions(jdbcTemplate);
    }
}
