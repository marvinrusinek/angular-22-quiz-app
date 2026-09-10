package com.quizbackend.quiz.topicquiz;

import com.quizbackend.interview.CandidateOption;
import com.quizbackend.interview.CandidateQuestion;
import com.quizbackend.interview.InterviewQuestionRepository;
import com.quizbackend.quiz.QuizRepository;
import com.quizbackend.quiz.QuizResourceRepository;
import com.quizbackend.quiz.dto.AttemptIssuedDto;
import com.quizbackend.quiz.dto.CodeSnippetDto;
import com.quizbackend.quiz.dto.QuestionStartedDto;
import com.quizbackend.quiz.dto.QuizResourcesBody;
import com.quizbackend.quiz.dto.TopicQuizOptionDto;
import com.quizbackend.quiz.dto.TopicQuizQuestionDto;
import com.quizbackend.quiz.dto.TopicQuizQuestionsDto;
import com.quizbackend.quiz.entity.QuizEntity;
import com.quizbackend.quiz.ratelimit.CheckRateLimiter;
import com.quizbackend.quiz.ratelimit.RateLimitedException;
import com.quizbackend.quiz.ratelimit.TokenBucketRateLimiter;
import com.quizbackend.quiz.receipt.AttemptReceiptPayload;
import com.quizbackend.quiz.receipt.AttemptReceiptSigner;
import com.quizbackend.quiz.receipt.QuestionReceiptPayload;
import com.quizbackend.quiz.receipt.QuestionReceiptSigner;
import com.quizbackend.quiz.receipt.ReceiptCodec;
import com.quizbackend.quiz.receipt.TopicQuizReceiptSecret;
import com.quizbackend.web.error.ApiException;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.LongSupplier;

/**
 * Topic Quiz orchestration — port of the Node reference's {@code
 * quizzes.route.ts} handlers for the receipt-based protocol (question
 * delivery, resources, attempt issuance, question-start, and the answer
 * check). Knows nothing about Spring MVC beyond plain values in, plain
 * values out, matching every other service in this migration.
 *
 * <p>Reuses {@link InterviewQuestionRepository#findByQuizId} for question
 * CONTENT — the same frozen-from-PostgreSQL {@link CandidateQuestion} list
 * Interview Mode's assessment builder already reads, since Node's own
 * {@code QuizRepository} is likewise the ONE module both features read
 * from. Topic Quiz strips every identifier before the wire; Interview Mode
 * keeps them — the two DTOs diverge, the source data does not.
 */
@Service
public class TopicQuizService {

    private static final String ACTIVE = "active";
    /** One question's countdown, matching the Angular {@code timePerQuestion}. */
    private static final int QUESTION_DURATION_SECONDS = QuestionReceiptSigner.QUESTION_DURATION_SECONDS;

    private final QuizRepository quizRepository;
    private final InterviewQuestionRepository questionRepository;
    private final QuizResourceRepository resourceRepository;
    private final AttemptReceiptSigner attemptReceiptSigner;
    private final QuestionReceiptSigner questionReceiptSigner;
    private final TopicQuizReceiptSecret receiptSecret;
    private final CheckRateLimiter rateLimiter;
    private final LongSupplier now;

    /**
     * Lazily-populated, per-quiz immutable cache of Topic Quiz candidate
     * question/option content — the same {@link CandidateQuestion} list
     * {@link InterviewQuestionRepository#findByQuizId} returns, loaded from
     * PostgreSQL at most once per quiz for the life of this (Spring
     * singleton) service instance.
     *
     * <p>SAFE TO CACHE: question/option CONTENT is populated once by
     * {@code scripts/import-quiz-bank.ts} and never written by either
     * running backend — no {@code INSERT}/{@code UPDATE}/{@code DELETE}
     * against {@code questions}/{@code options} exists anywhere in this
     * repository (verified, not assumed). It is deployment-time content,
     * exactly like the Node reference's own in-memory quiz bank, loaded
     * once at startup and never re-queried per request.
     *
     * <p>DELIBERATELY DOES <b>NOT</b> COVER {@link #requireActiveQuiz}: a
     * quiz's {@code status} (active vs retired) is the one thing this
     * migration has repeatedly treated as able to change independently of
     * a deploy (see the {@code test-retired} fixtures throughout the
     * PostgreSQL integration suite) — retiring a quiz must take effect
     * promptly, without a backend restart. See {@link #activeStatusCache}
     * below for the short-TTL (not process-lifetime) cache that now covers
     * that check instead of a fresh query on every single call.
     *
     * <p>{@link ConcurrentHashMap#computeIfAbsent} gives per-key atomicity —
     * simultaneous first requests for the SAME quiz block on each other and
     * only one PostgreSQL load happens, while a slow first load for one quiz
     * never blocks a concurrent request for a different quiz. {@link
     * List#copyOf} defends the cached value against in-place mutation.
     */
    private final ConcurrentHashMap<String, List<CandidateQuestion>> questionBankCache = new ConcurrentHashMap<>();

    private List<CandidateQuestion> loadQuestions(String quizId) {
        return questionBankCache.computeIfAbsent(quizId, id -> List.copyOf(questionRepository.findByQuizId(id)));
    }

    /** How long a cached active/retired verdict is trusted before being re-checked against PostgreSQL. */
    private static final long ACTIVE_STATUS_TTL_MILLIS = 10_000L;

    /**
     * One cached quiz's active/retired verdict, plus the {@code difficulty}
     * {@link #getQuestions} needs — both read from the SAME
     * {@code quizRepository.findByQuizIdAndStatus} row, so caching one costs
     * nothing extra for the other. {@code active=false} (an unknown OR
     * retired quiz) is cached too — otherwise a repeated lookup for a
     * nonexistent/retired id would bypass the cache entirely on every call.
     */
    private record ActiveStatusEntry(boolean active, String difficulty, long expiresAtMillis) {
    }

    /**
     * Short-TTL (10s), per-quiz cache of {@link #requireActiveQuiz}'s
     * verdict — separate from {@link #questionBankCache} above, which is
     * process-lifetime, because active/retired status is the one thing this
     * migration has repeatedly treated as able to change independently of a
     * deploy (unlike question/option CONTENT, which has zero write path
     * anywhere in this repository). A bounded TTL trades a worst-case 10s of
     * staleness after a retirement for eliminating the Neon round trip that
     * otherwise dominates every warm {@code /check} (measured: ~77-370ms of
     * jitter on this ONE remaining live query, vastly more than everything
     * else in the request combined).
     *
     * <p>Double-checks freshness INSIDE {@link ConcurrentHashMap#compute}
     * (not merely before calling it): {@code compute} serializes concurrent
     * callers for the same key, but by the time a second caller acquires
     * that lock, a first caller may have ALREADY refreshed the entry: without
     * re-checking freshness inside the lambda, the second caller would
     * needlessly re-query Postgres purely because its own OUTER staleness
     * check ran before the first caller finished. This is what makes BOTH
     * "concurrent first lookups" and "concurrent expired-entry refreshes"
     * for the same quiz collapse to exactly one repository call, not just
     * the first case.
     */
    private final ConcurrentHashMap<String, ActiveStatusEntry> activeStatusCache = new ConcurrentHashMap<>();

    private ActiveStatusEntry loadActiveStatus(String quizId) {
        ActiveStatusEntry cached = activeStatusCache.get(quizId);
        if (cached != null && now.getAsLong() < cached.expiresAtMillis()) {
            return cached;
        }
        return activeStatusCache.compute(quizId, (id, existing) -> {
            long nowMillis = now.getAsLong();
            if (existing != null && nowMillis < existing.expiresAtMillis()) {
                return existing;
            }
            Optional<QuizEntity> found = quizRepository.findByQuizIdAndStatus(id, ACTIVE);
            return new ActiveStatusEntry(
                    found.isPresent(), found.map(QuizEntity::getDifficulty).orElse(null),
                    nowMillis + ACTIVE_STATUS_TTL_MILLIS);
        });
    }

    @Autowired
    public TopicQuizService(
            QuizRepository quizRepository,
            InterviewQuestionRepository questionRepository,
            QuizResourceRepository resourceRepository,
            AttemptReceiptSigner attemptReceiptSigner,
            QuestionReceiptSigner questionReceiptSigner,
            TopicQuizReceiptSecret receiptSecret,
            CheckRateLimiter rateLimiter) {
        this(quizRepository, questionRepository, resourceRepository, attemptReceiptSigner,
                questionReceiptSigner, receiptSecret, rateLimiter, System::currentTimeMillis);
    }

    /** Test/advanced constructor — injects a deterministic clock. */
    public TopicQuizService(
            QuizRepository quizRepository,
            InterviewQuestionRepository questionRepository,
            QuizResourceRepository resourceRepository,
            AttemptReceiptSigner attemptReceiptSigner,
            QuestionReceiptSigner questionReceiptSigner,
            TopicQuizReceiptSecret receiptSecret,
            CheckRateLimiter rateLimiter,
            LongSupplier now) {
        this.quizRepository = quizRepository;
        this.questionRepository = questionRepository;
        this.resourceRepository = resourceRepository;
        this.attemptReceiptSigner = attemptReceiptSigner;
        this.questionReceiptSigner = questionReceiptSigner;
        this.receiptSecret = receiptSecret;
        this.rateLimiter = rateLimiter;
        this.now = now;
    }

    private ActiveStatusEntry requireActiveQuiz(String quizId) {
        ActiveStatusEntry status = loadActiveStatus(quizId);
        if (!status.active()) {
            throw ApiException.notFound("Quiz not found");
        }
        return status;
    }

    // ── GET .../questions ────────────────────────────────────────────────

    public TopicQuizQuestionsDto getQuestions(String quizId) {
        ActiveStatusEntry status = requireActiveQuiz(quizId);
        List<CandidateQuestion> questions = loadQuestions(quizId);

        List<TopicQuizQuestionDto> dtos = questions.stream()
                .map(q -> toTopicQuizQuestionDto(q, status.difficulty()))
                .toList();
        return new TopicQuizQuestionsDto(quizId, dtos);
    }

    private TopicQuizQuestionDto toTopicQuizQuestionDto(CandidateQuestion question, String difficulty) {
        List<TopicQuizOptionDto> options = question.options().stream()
                .map(o -> new TopicQuizOptionDto(o.text()))
                .toList();
        int correctCount = (int) question.options().stream().filter(CandidateOption::isCorrect).count();
        CodeSnippetDto codeSnippet = question.codeSnippet() == null ? null
                : new CodeSnippetDto(question.codeSnippet().language(), question.codeSnippet().code(),
                        question.codeSnippet().filename());
        return new TopicQuizQuestionDto(
                question.questionText(), question.type(), difficulty, correctCount, options, codeSnippet);
    }

    // ── GET .../resources ────────────────────────────────────────────────

    public QuizResourcesBody getResources(String quizId) {
        requireActiveQuiz(quizId);
        return new QuizResourcesBody(quizId, resourceRepository.findByQuizId(quizId));
    }

    // ── POST .../attempts ────────────────────────────────────────────────

    public AttemptIssuedDto issueAttempt(String quizId) {
        requireActiveQuiz(quizId);
        List<CandidateQuestion> questions = loadQuestions(quizId);

        long startedAt = now.getAsLong();
        int durationSeconds = questions.size() * QUESTION_DURATION_SECONDS;
        long expiresAt = startedAt + durationSeconds * 1000L;

        String receipt = attemptReceiptSigner.issue(
                new AttemptReceiptPayload(ReceiptCodec.RECEIPT_VERSION, quizId, startedAt, expiresAt),
                receiptSecret.value());

        return new AttemptIssuedDto(quizId, durationSeconds, startedAt, expiresAt, receipt);
    }

    // ── POST .../questions/start ─────────────────────────────────────────

    /**
     * Requires a valid ATTEMPT receipt for THIS quiz. Deliberately does
     * NOT check the attempt receipt's own expiry — Node's own {@code
     * verifyAttemptReceipt} never rejects on expiry either; only the
     * newly-issued QUESTION receipt's deadline (checked in {@link #check})
     * ever gates a reveal.
     */
    public QuestionStartedDto startQuestion(String quizId, String attemptReceipt, Object questionTextRaw) {
        AttemptReceiptPayload attempt = attemptReceiptSigner.verify(attemptReceipt, receiptSecret.value());
        if (!attempt.quizId().equals(quizId)) {
            throw new com.quizbackend.quiz.receipt.AttemptReceiptException();
        }

        requireActiveQuiz(quizId);
        List<CandidateQuestion> quizQuestions = loadQuestions(quizId);
        CandidateQuestion question = AnswerCheck.findQuestion(quizQuestions, questionTextRaw);

        long startedAt = now.getAsLong();
        long expiresAt = startedAt + QUESTION_DURATION_SECONDS * 1000L;

        String receipt = questionReceiptSigner.issue(
                new QuestionReceiptPayload(ReceiptCodec.RECEIPT_VERSION, quizId, question.questionText(), startedAt, expiresAt),
                receiptSecret.value());

        return new QuestionStartedDto(quizId, question.questionText(), QUESTION_DURATION_SECONDS, startedAt, expiresAt, receipt);
    }

    // ── POST .../check ───────────────────────────────────────────────────

    /**
     * Rate-limited FIRST, before the receipt is even inspected — matching
     * Node's middleware order ({@code checkRateLimiter} runs before {@code
     * setResponsePolicy}/receipt verification), so a throttled probe learns
     * nothing about receipt validity either.
     */
    public CheckOutcome check(
            String quizId, String questionReceipt, Object questionTextRaw, Object selectedOptionTextsRaw,
            String clientKey) {
        TokenBucketRateLimiter.Verdict verdict = rateLimiter.tryConsume(clientKey);
        if (!verdict.allowed()) {
            throw new RateLimitedException(verdict.retryAfterSeconds());
        }

        QuestionReceiptPayload payload = questionReceiptSigner.verify(questionReceipt, receiptSecret.value());
        if (!payload.quizId().equals(quizId)) {
            throw new com.quizbackend.quiz.receipt.QuestionReceiptException();
        }

        requireActiveQuiz(quizId);
        List<CandidateQuestion> quizQuestions = loadQuestions(quizId);

        // The receipt is bound to ONE question. Without this, a receipt
        // whose deadline has passed would authorize the expiry reveal for
        // EVERY question in the quiz — compared canonically, matching how
        // findQuestion resolves the body's question.
        if (!(questionTextRaw instanceof String submittedText)
                || !AnswerCheck.canonicalize(submittedText).equals(AnswerCheck.canonicalize(payload.questionText()))) {
            throw new com.quizbackend.quiz.receipt.QuestionReceiptException();
        }

        CandidateQuestion question = AnswerCheck.findQuestion(quizQuestions, questionTextRaw);
        boolean expired = now.getAsLong() >= payload.expiresAt();
        return AnswerCheck.checkAnswer(question, selectedOptionTextsRaw, expired);
    }
}
