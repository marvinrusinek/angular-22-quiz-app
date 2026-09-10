package com.quizbackend.quiz.topicquiz;

import com.quizbackend.interview.CandidateOption;
import com.quizbackend.interview.CandidateQuestion;
import com.quizbackend.interview.InterviewQuestionRepository;
import com.quizbackend.quiz.QuizRepository;
import com.quizbackend.quiz.QuizResourceRepository;
import com.quizbackend.quiz.dto.AttemptIssuedDto;
import com.quizbackend.quiz.dto.QuestionStartedDto;
import com.quizbackend.quiz.dto.QuizResourceDto;
import com.quizbackend.quiz.dto.TopicQuizQuestionsDto;
import com.quizbackend.quiz.entity.QuizEntity;
import com.quizbackend.quiz.ratelimit.CheckRateLimiter;
import com.quizbackend.quiz.receipt.AttemptReceiptException;
import com.quizbackend.quiz.receipt.AttemptReceiptSigner;
import com.quizbackend.quiz.receipt.QuestionReceiptException;
import com.quizbackend.quiz.receipt.QuestionReceiptSigner;
import com.quizbackend.quiz.receipt.ReceiptCodec;
import com.quizbackend.quiz.receipt.TopicQuizReceiptSecret;
import com.quizbackend.quiz.ratelimit.RateLimitedException;
import com.quizbackend.web.error.ApiException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import tools.jackson.databind.ObjectMapper;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Orchestration proof against the Node reference's Topic Quiz route
 * handlers ({@code quizzes.route.ts}). Repositories are mocked; the
 * receipt signers/secret/rate limiter are REAL (not mocked) so this class
 * proves the actual issue-then-verify lifecycle end to end, not merely
 * that the service calls the right methods.
 */
@ExtendWith(MockitoExtension.class)
class TopicQuizServiceTest {

    private static final String SECRET = "test-secret-at-least-thirty-two-chars-long";
    private static final long FIXED_NOW = 1_700_000_000_000L;

    @Mock
    private QuizRepository quizRepository;
    @Mock
    private InterviewQuestionRepository questionRepository;
    @Mock
    private QuizResourceRepository resourceRepository;

    private final AttemptReceiptSigner attemptSigner = new AttemptReceiptSigner(new ReceiptCodec(new ObjectMapper()));
    private final QuestionReceiptSigner questionSigner = new QuestionReceiptSigner(new ReceiptCodec(new ObjectMapper()));
    private final TopicQuizReceiptSecret secret = new TopicQuizReceiptSecret(SECRET);
    private final CheckRateLimiter rateLimiter = new CheckRateLimiter();

    private long[] clock = { FIXED_NOW };

    private TopicQuizService service() {
        return new TopicQuizService(quizRepository, questionRepository, resourceRepository,
                attemptSigner, questionSigner, secret, rateLimiter, () -> clock[0]);
    }

    private static QuizEntity activeQuiz(String quizId, String difficulty) {
        return new QuizEntity(1L, quizId, "RxJS", "s", "i", difficulty, "[]", 0, "active");
    }

    private static CandidateOption opt(int id, String text, boolean correct) {
        return new CandidateOption(id, id, text, correct);
    }

    private static CandidateQuestion question(String text) {
        return new CandidateQuestion("rxjs:q:0", "rxjs", 0, text, "single", "Because.",
                List.of(opt(101, "A multicast observable", true), opt(102, "A pipe", false)), null);
    }

    // ── GET .../questions ────────────────────────────────────────────────

    @Test
    void getQuestionsMapsCandidateQuestionsIntoTheStrippedTopicQuizDto() {
        when(quizRepository.findByQuizIdAndStatus("rxjs", "active")).thenReturn(Optional.of(activeQuiz("rxjs", "beginner")));
        when(questionRepository.findByQuizId("rxjs")).thenReturn(List.of(question("Which answer is correct?")));

        TopicQuizQuestionsDto dto = service().getQuestions("rxjs");

        assertThat(dto.quizId()).isEqualTo("rxjs");
        assertThat(dto.questions()).hasSize(1);
        assertThat(dto.questions().get(0).questionText()).isEqualTo("Which answer is correct?");
        assertThat(dto.questions().get(0).difficulty()).isEqualTo("beginner");
        assertThat(dto.questions().get(0).correctCount()).isEqualTo(1);
        assertThat(dto.questions().get(0).options()).extracting("text")
                .containsExactly("A multicast observable", "A pipe");
    }

    @Test
    void getQuestionsThrowsNotFoundForAnUnknownOrRetiredQuiz() {
        when(quizRepository.findByQuizIdAndStatus("nope", "active")).thenReturn(Optional.empty());
        assertThatThrownBy(() -> service().getQuestions("nope"))
                .isInstanceOf(ApiException.class)
                .satisfies(ex -> assertThat(((ApiException) ex).getCode()).isEqualTo("NOT_FOUND"));
    }

    // ── GET .../resources ────────────────────────────────────────────────

    @Test
    void getResourcesReturnsTheRepositoryListForAKnownQuiz() {
        when(quizRepository.findByQuizIdAndStatus("rxjs", "active")).thenReturn(Optional.of(activeQuiz("rxjs", "beginner")));
        when(resourceRepository.findByQuizId("rxjs")).thenReturn(List.of(new QuizResourceDto("t", "u", "h")));

        var body = service().getResources("rxjs");
        assertThat(body.quizId()).isEqualTo("rxjs");
        assertThat(body.resources()).hasSize(1);
    }

    @Test
    void getResourcesThrowsNotFoundForAnUnknownQuizRatherThanReturningEmpty() {
        when(quizRepository.findByQuizIdAndStatus("nope", "active")).thenReturn(Optional.empty());
        assertThatThrownBy(() -> service().getResources("nope")).isInstanceOf(ApiException.class);
        verify(resourceRepository, never()).findByQuizId(any());
    }

    // ── POST .../attempts ────────────────────────────────────────────────

    @Test
    void issueAttemptComputesDurationFromQuestionCountAndSignsAVerifiableReceipt() {
        when(quizRepository.findByQuizIdAndStatus("rxjs", "active")).thenReturn(Optional.of(activeQuiz("rxjs", "beginner")));
        when(questionRepository.findByQuizId("rxjs")).thenReturn(List.of(question("q0"), question("q1"), question("q2"), question("q3")));

        AttemptIssuedDto dto = service().issueAttempt("rxjs");

        assertThat(dto.quizId()).isEqualTo("rxjs");
        assertThat(dto.startedAt()).isEqualTo(FIXED_NOW);
        assertThat(dto.durationSeconds()).isEqualTo(4 * 30);
        assertThat(dto.expiresAt()).isEqualTo(FIXED_NOW + 4 * 30 * 1000L);

        // The receipt genuinely verifies — not merely a well-formed-looking string.
        var verified = attemptSigner.verify(dto.attemptReceipt(), SECRET);
        assertThat(verified.quizId()).isEqualTo("rxjs");
        assertThat(verified.expiresAt()).isEqualTo(dto.expiresAt());
    }

    @Test
    void issueAttemptThrowsNotFoundForAnUnknownQuiz() {
        when(quizRepository.findByQuizIdAndStatus("nope", "active")).thenReturn(Optional.empty());
        assertThatThrownBy(() -> service().issueAttempt("nope")).isInstanceOf(ApiException.class);
    }

    // ── POST .../questions/start ─────────────────────────────────────────

    @Test
    void startQuestionIssuesAQuestionReceiptBoundToTheResolvedQuestionText() {
        when(quizRepository.findByQuizIdAndStatus("rxjs", "active")).thenReturn(Optional.of(activeQuiz("rxjs", "beginner")));
        lenient().when(questionRepository.findByQuizId("rxjs")).thenReturn(List.of(question("Which answer is correct?")));

        String attemptReceipt = attemptSigner.issue(
                new com.quizbackend.quiz.receipt.AttemptReceiptPayload(1, "rxjs", FIXED_NOW, FIXED_NOW + 120_000), SECRET);

        QuestionStartedDto dto = service().startQuestion("rxjs", attemptReceipt, "  which ANSWER is correct?  ");

        assertThat(dto.quizId()).isEqualTo("rxjs");
        assertThat(dto.questionText()).isEqualTo("Which answer is correct?"); // canonical stored text, not the client's casing
        assertThat(dto.durationSeconds()).isEqualTo(30);
        var verified = questionSigner.verify(dto.questionReceipt(), SECRET);
        assertThat(verified.questionText()).isEqualTo("Which answer is correct?");
    }

    @Test
    void startQuestionRejectsAnAttemptReceiptForAnotherQuiz() {
        String attemptReceipt = attemptSigner.issue(
                new com.quizbackend.quiz.receipt.AttemptReceiptPayload(1, "signals", FIXED_NOW, FIXED_NOW + 120_000), SECRET);

        assertThatThrownBy(() -> service().startQuestion("rxjs", attemptReceipt, "x"))
                .isInstanceOf(AttemptReceiptException.class);
        verify(quizRepository, never()).findByQuizIdAndStatus(any(), any());
    }

    @Test
    void startQuestionRejectsAMissingOrMalformedAttemptReceipt() {
        assertThatThrownBy(() -> service().startQuestion("rxjs", null, "x")).isInstanceOf(AttemptReceiptException.class);
        assertThatThrownBy(() -> service().startQuestion("rxjs", "garbage", "x")).isInstanceOf(AttemptReceiptException.class);
    }

    @Test
    void startQuestionRejectsAQuestionNotInThisQuizAsInvalidSubmission() {
        when(quizRepository.findByQuizIdAndStatus("rxjs", "active")).thenReturn(Optional.of(activeQuiz("rxjs", "beginner")));
        when(questionRepository.findByQuizId("rxjs")).thenReturn(List.of(question("Which answer is correct?")));

        String attemptReceipt = attemptSigner.issue(
                new com.quizbackend.quiz.receipt.AttemptReceiptPayload(1, "rxjs", FIXED_NOW, FIXED_NOW + 120_000), SECRET);

        assertThatThrownBy(() -> service().startQuestion("rxjs", attemptReceipt, "No such question"))
                .isInstanceOf(AnswerCheckException.class);
    }

    @Test
    void startQuestionDoesNotRejectOnAnAlreadyExpiredAttemptReceipt() {
        // Node's own verifyAttemptReceipt never rejects on expiry — only the
        // newly-issued QUESTION receipt's deadline gates a reveal.
        when(quizRepository.findByQuizIdAndStatus("rxjs", "active")).thenReturn(Optional.of(activeQuiz("rxjs", "beginner")));
        when(questionRepository.findByQuizId("rxjs")).thenReturn(List.of(question("Which answer is correct?")));

        String longExpiredAttempt = attemptSigner.issue(
                new com.quizbackend.quiz.receipt.AttemptReceiptPayload(1, "rxjs", 1L, 2L), SECRET);

        QuestionStartedDto dto = service().startQuestion("rxjs", longExpiredAttempt, "Which answer is correct?");
        assertThat(dto.quizId()).isEqualTo("rxjs");
    }

    // ── POST .../check ───────────────────────────────────────────────────

    private String questionReceiptFor(String quizId, String questionText, long startedAt, long expiresAt) {
        return questionSigner.issue(
                new com.quizbackend.quiz.receipt.QuestionReceiptPayload(1, quizId, questionText, startedAt, expiresAt), SECRET);
    }

    @Test
    void checkResolvesAValidAnswerAgainstAGenuineQuestionReceipt() {
        when(quizRepository.findByQuizIdAndStatus("rxjs", "active")).thenReturn(Optional.of(activeQuiz("rxjs", "beginner")));
        when(questionRepository.findByQuizId("rxjs")).thenReturn(List.of(question("Which answer is correct?")));
        String receipt = questionReceiptFor("rxjs", "Which answer is correct?", FIXED_NOW, FIXED_NOW + 30_000);

        var outcome = (ResolvedCheckOutcome) service().check(
                "rxjs", receipt, "Which answer is correct?", List.of("A multicast observable"), "1.2.3.4");

        assertThat(outcome.status()).isEqualTo("resolved");
        assertThat(outcome.correct()).isTrue();
    }

    @Test
    void checkIsRateLimitedBeforeTheReceiptIsEvenInspected() {
        CheckRateLimiter exhausted = new CheckRateLimiter();
        // Drain the bucket entirely for this key first.
        for (int i = 0; i < 40; i++) {
            exhausted.tryConsume("9.9.9.9");
        }
        TopicQuizService rateLimitedService = new TopicQuizService(quizRepository, questionRepository, resourceRepository,
                attemptSigner, questionSigner, secret, exhausted, () -> clock[0]);

        // Even a garbage receipt must fail with RATE_LIMITED, not a receipt error —
        // proving the rate-limit check runs FIRST.
        assertThatThrownBy(() -> rateLimitedService.check("rxjs", "garbage-receipt", "x", List.of(), "9.9.9.9"))
                .isInstanceOf(RateLimitedException.class);
        verify(quizRepository, never()).findByQuizIdAndStatus(any(), any());
    }

    @Test
    void checkRejectsAQuestionReceiptForAnotherQuiz() {
        String receipt = questionReceiptFor("signals", "x", FIXED_NOW, FIXED_NOW + 30_000);
        assertThatThrownBy(() -> service().check("rxjs", receipt, "x", List.of(), "1.2.3.4"))
                .isInstanceOf(QuestionReceiptException.class);
    }

    @Test
    void checkRejectsWhenTheSubmittedQuestionTextDoesNotMatchTheReceiptsBoundQuestion() {
        when(quizRepository.findByQuizIdAndStatus("rxjs", "active")).thenReturn(Optional.of(activeQuiz("rxjs", "beginner")));
        String receipt = questionReceiptFor("rxjs", "Which answer is correct?", FIXED_NOW, FIXED_NOW + 30_000);

        // A receipt legitimately held for one question must not authorize
        // submitting a DIFFERENT question's answer against it.
        assertThatThrownBy(() -> service().check("rxjs", receipt, "A totally different question", List.of(), "1.2.3.4"))
                .isInstanceOf(QuestionReceiptException.class);
    }

    @Test
    void checkRejectsAMissingOrMalformedQuestionReceipt() {
        assertThatThrownBy(() -> service().check("rxjs", null, "x", List.of(), "1.2.3.4"))
                .isInstanceOf(QuestionReceiptException.class);
        assertThatThrownBy(() -> service().check("rxjs", "garbage", "x", List.of(), "1.2.3.4"))
                .isInstanceOf(QuestionReceiptException.class);
    }

    @Test
    void checkTreatsTheSignedDeadlineAsAuthoritativeForExpiry() {
        when(quizRepository.findByQuizIdAndStatus("rxjs", "active")).thenReturn(Optional.of(activeQuiz("rxjs", "beginner")));
        when(questionRepository.findByQuizId("rxjs")).thenReturn(List.of(question("Which answer is correct?")));
        String receipt = questionReceiptFor("rxjs", "Which answer is correct?", FIXED_NOW, FIXED_NOW + 30_000);

        clock[0] = FIXED_NOW + 30_000; // now >= expiresAt

        var outcome = (ExpiredCheckOutcome) service().check(
                "rxjs", receipt, "Which answer is correct?", List.of(), "1.2.3.4");
        assertThat(outcome.status()).isEqualTo("expired");
    }

    // ── question-bank caching ────────────────────────────────────────────

    @Test
    void firstCheckForAQuizLoadsCandidateQuestionsFromTheRepository() {
        when(quizRepository.findByQuizIdAndStatus("rxjs", "active")).thenReturn(Optional.of(activeQuiz("rxjs", "beginner")));
        when(questionRepository.findByQuizId("rxjs")).thenReturn(List.of(question("Which answer is correct?")));
        String receipt = questionReceiptFor("rxjs", "Which answer is correct?", FIXED_NOW, FIXED_NOW + 30_000);

        service().check("rxjs", receipt, "Which answer is correct?", List.of("A multicast observable"), "1.2.3.4");

        verify(questionRepository, times(1)).findByQuizId("rxjs");
    }

    @Test
    void subsequentChecksForTheSameQuizReuseTheCachedCandidateQuestionsRatherThanReloading() {
        when(quizRepository.findByQuizIdAndStatus("rxjs", "active")).thenReturn(Optional.of(activeQuiz("rxjs", "beginner")));
        when(questionRepository.findByQuizId("rxjs")).thenReturn(List.of(question("Which answer is correct?")));

        TopicQuizService service = service();
        for (int i = 0; i < 3; i++) {
            String receipt = questionReceiptFor("rxjs", "Which answer is correct?", FIXED_NOW, FIXED_NOW + 30_000);
            service.check("rxjs", receipt, "Which answer is correct?", List.of("A multicast observable"), "1.2.3.4");
        }

        // Three /check calls, but the repository's content query ran only once.
        verify(questionRepository, times(1)).findByQuizId("rxjs");
        // The active-quiz status check now has its own short-TTL cache (see
        // the "active-status short-TTL caching" tests below) — all three
        // calls land inside the same 10s window with no clock advance
        // between them, so this also ran only once, not three times.
        verify(quizRepository, times(1)).findByQuizIdAndStatus("rxjs", "active");
    }

    @Test
    void differentQuizIdsGetSeparateCacheEntriesAndBothLoadIndependently() {
        when(quizRepository.findByQuizIdAndStatus("rxjs", "active")).thenReturn(Optional.of(activeQuiz("rxjs", "beginner")));
        when(quizRepository.findByQuizIdAndStatus("signals", "active")).thenReturn(Optional.of(activeQuiz("signals", "beginner")));
        when(questionRepository.findByQuizId("rxjs")).thenReturn(List.of(question("RxJS question?")));
        when(questionRepository.findByQuizId("signals")).thenReturn(List.of(question("Signals question?")));

        TopicQuizService service = service();
        String rxjsReceipt = questionReceiptFor("rxjs", "RxJS question?", FIXED_NOW, FIXED_NOW + 30_000);
        String signalsReceipt = questionReceiptFor("signals", "Signals question?", FIXED_NOW, FIXED_NOW + 30_000);

        service.check("rxjs", rxjsReceipt, "RxJS question?", List.of("A multicast observable"), "1.2.3.4");
        service.check("signals", signalsReceipt, "Signals question?", List.of("A multicast observable"), "1.2.3.4");
        service.check("rxjs", rxjsReceipt, "RxJS question?", List.of("A multicast observable"), "1.2.3.4");

        verify(questionRepository, times(1)).findByQuizId("rxjs");
        verify(questionRepository, times(1)).findByQuizId("signals");
    }

    @Test
    void concurrentFirstChecksForTheSameQuizLoadTheRepositoryExactlyOnce() throws Exception {
        when(quizRepository.findByQuizIdAndStatus("rxjs", "active")).thenReturn(Optional.of(activeQuiz("rxjs", "beginner")));
        // A small artificial delay widens the race window so the assertion
        // proves the concurrency guarantee rather than relying on timing luck.
        when(questionRepository.findByQuizId("rxjs")).thenAnswer(invocation -> {
            Thread.sleep(50);
            return List.of(question("Which answer is correct?"));
        });

        TopicQuizService service = service();
        int threadCount = 8;
        ExecutorService pool = Executors.newFixedThreadPool(threadCount);
        CyclicBarrier barrier = new CyclicBarrier(threadCount);
        try {
            List<Future<?>> futures = new ArrayList<>();
            for (int i = 0; i < threadCount; i++) {
                futures.add(pool.submit(() -> {
                    try {
                        barrier.await();
                        String receipt = questionReceiptFor("rxjs", "Which answer is correct?", FIXED_NOW, FIXED_NOW + 30_000);
                        service.check("rxjs", receipt, "Which answer is correct?", List.of("A multicast observable"), "1.2.3.4");
                    } catch (Exception e) {
                        throw new RuntimeException(e);
                    }
                }));
            }
            for (Future<?> future : futures) {
                future.get(10, TimeUnit.SECONDS);
            }
        } finally {
            pool.shutdownNow();
        }

        verify(questionRepository, times(1)).findByQuizId("rxjs");
    }

    // ── active-status short-TTL caching ──────────────────────────────────
    //
    // Driven through getResources() rather than check(): it hits
    // requireActiveQuiz() exactly like every other Topic Quiz method, needs
    // no receipt chain, and its only other repository call
    // (resourceRepository.findByQuizId) is irrelevant to what's being
    // proven here.

    private static final long ACTIVE_STATUS_TTL_MILLIS = 10_000L;

    @Test
    void initialActiveStatusLookupQueriesTheRepository() {
        when(quizRepository.findByQuizIdAndStatus("rxjs", "active")).thenReturn(Optional.of(activeQuiz("rxjs", "beginner")));
        when(resourceRepository.findByQuizId("rxjs")).thenReturn(List.of());

        service().getResources("rxjs");

        verify(quizRepository, times(1)).findByQuizIdAndStatus("rxjs", "active");
    }

    @Test
    void activeStatusIsReusedForCallsWithinTheTtlWindow() {
        when(quizRepository.findByQuizIdAndStatus("rxjs", "active")).thenReturn(Optional.of(activeQuiz("rxjs", "beginner")));
        when(resourceRepository.findByQuizId("rxjs")).thenReturn(List.of());

        TopicQuizService service = service();
        service.getResources("rxjs");
        clock[0] += ACTIVE_STATUS_TTL_MILLIS - 1;
        service.getResources("rxjs");

        verify(quizRepository, times(1)).findByQuizIdAndStatus("rxjs", "active");
    }

    @Test
    void activeStatusRefreshesFromPostgresAfterTheTtlExpires() {
        when(quizRepository.findByQuizIdAndStatus("rxjs", "active")).thenReturn(Optional.of(activeQuiz("rxjs", "beginner")));
        when(resourceRepository.findByQuizId("rxjs")).thenReturn(List.of());

        TopicQuizService service = service();
        service.getResources("rxjs");
        clock[0] += ACTIVE_STATUS_TTL_MILLIS;
        service.getResources("rxjs");

        verify(quizRepository, times(2)).findByQuizIdAndStatus("rxjs", "active");
    }

    @Test
    void anActiveToRetiredTransitionBecomesVisibleNoLaterThanTheTtlBoundary() {
        when(quizRepository.findByQuizIdAndStatus("rxjs", "active"))
                .thenReturn(Optional.of(activeQuiz("rxjs", "beginner"))) // first lookup: active
                .thenReturn(Optional.empty()); // retired by the time the TTL forces a refresh
        when(resourceRepository.findByQuizId("rxjs")).thenReturn(List.of());

        TopicQuizService service = service();
        service.getResources("rxjs"); // active, cached for ACTIVE_STATUS_TTL_MILLIS
        clock[0] += ACTIVE_STATUS_TTL_MILLIS;

        assertThatThrownBy(() -> service.getResources("rxjs")).isInstanceOf(ApiException.class);
        verify(quizRepository, times(2)).findByQuizIdAndStatus("rxjs", "active");
    }

    @Test
    void aNegativeResultForAnUnknownOrRetiredQuizIsAlsoCachedRatherThanRequeryingEveryCall() {
        when(quizRepository.findByQuizIdAndStatus("nope", "active")).thenReturn(Optional.empty());

        TopicQuizService service = service();
        assertThatThrownBy(() -> service.getResources("nope")).isInstanceOf(ApiException.class);
        assertThatThrownBy(() -> service.getResources("nope")).isInstanceOf(ApiException.class);

        // Existing rejection semantics unchanged (still NOT_FOUND both times)
        // AND only one repository call for both — the negative verdict itself
        // is what's cached, not merely skipped.
        verify(quizRepository, times(1)).findByQuizIdAndStatus("nope", "active");
    }

    @Test
    void differentQuizIdsHaveIndependentActiveStatusCacheEntries() {
        when(quizRepository.findByQuizIdAndStatus("rxjs", "active")).thenReturn(Optional.of(activeQuiz("rxjs", "beginner")));
        when(quizRepository.findByQuizIdAndStatus("signals", "active")).thenReturn(Optional.of(activeQuiz("signals", "beginner")));
        when(resourceRepository.findByQuizId(any())).thenReturn(List.of());

        TopicQuizService service = service();
        service.getResources("rxjs");
        service.getResources("signals");
        service.getResources("rxjs");

        verify(quizRepository, times(1)).findByQuizIdAndStatus("rxjs", "active");
        verify(quizRepository, times(1)).findByQuizIdAndStatus("signals", "active");
    }

    @Test
    void concurrentFirstActiveStatusLookupsForTheSameQuizQueryTheRepositoryExactlyOnce() throws Exception {
        when(quizRepository.findByQuizIdAndStatus("rxjs", "active")).thenAnswer(invocation -> {
            Thread.sleep(50);
            return Optional.of(activeQuiz("rxjs", "beginner"));
        });
        when(resourceRepository.findByQuizId("rxjs")).thenReturn(List.of());

        TopicQuizService service = service();
        int threadCount = 8;
        ExecutorService pool = Executors.newFixedThreadPool(threadCount);
        CyclicBarrier barrier = new CyclicBarrier(threadCount);
        try {
            List<Future<?>> futures = new ArrayList<>();
            for (int i = 0; i < threadCount; i++) {
                futures.add(pool.submit(() -> {
                    try {
                        barrier.await();
                        service.getResources("rxjs");
                    } catch (Exception e) {
                        throw new RuntimeException(e);
                    }
                }));
            }
            for (Future<?> future : futures) {
                future.get(10, TimeUnit.SECONDS);
            }
        } finally {
            pool.shutdownNow();
        }

        verify(quizRepository, times(1)).findByQuizIdAndStatus("rxjs", "active");
    }

    @Test
    void concurrentExpiredEntryRefreshesForTheSameQuizQueryTheRepositoryExactlyOnce() throws Exception {
        when(quizRepository.findByQuizIdAndStatus("rxjs", "active"))
                .thenReturn(Optional.of(activeQuiz("rxjs", "beginner"))) // first call: instant, populates the cache
                .thenAnswer(invocation -> { // every call after that: slow, so the racers genuinely race the refresh
                    Thread.sleep(50);
                    return Optional.of(activeQuiz("rxjs", "beginner"));
                });
        when(resourceRepository.findByQuizId("rxjs")).thenReturn(List.of());

        TopicQuizService service = service();
        service.getResources("rxjs"); // populate; consumes the fast first stub
        clock[0] += ACTIVE_STATUS_TTL_MILLIS; // force every racer below to see a stale entry

        int threadCount = 8;
        ExecutorService pool = Executors.newFixedThreadPool(threadCount);
        CyclicBarrier barrier = new CyclicBarrier(threadCount);
        try {
            List<Future<?>> futures = new ArrayList<>();
            for (int i = 0; i < threadCount; i++) {
                futures.add(pool.submit(() -> {
                    try {
                        barrier.await();
                        service.getResources("rxjs");
                    } catch (Exception e) {
                        throw new RuntimeException(e);
                    }
                }));
            }
            for (Future<?> future : futures) {
                future.get(10, TimeUnit.SECONDS);
            }
        } finally {
            pool.shutdownNow();
        }

        // One populating call + exactly one refresh call, despite 8 racers.
        verify(quizRepository, times(2)).findByQuizIdAndStatus("rxjs", "active");
    }
}
