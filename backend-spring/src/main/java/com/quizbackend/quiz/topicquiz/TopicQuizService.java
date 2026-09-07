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

    private QuizEntity requireActiveQuiz(String quizId) {
        return quizRepository.findByQuizIdAndStatus(quizId, ACTIVE)
                .orElseThrow(() -> ApiException.notFound("Quiz not found"));
    }

    // ── GET .../questions ────────────────────────────────────────────────

    public TopicQuizQuestionsDto getQuestions(String quizId) {
        QuizEntity quiz = requireActiveQuiz(quizId);
        List<CandidateQuestion> questions = questionRepository.findByQuizId(quizId);

        List<TopicQuizQuestionDto> dtos = questions.stream()
                .map(q -> toTopicQuizQuestionDto(q, quiz.getDifficulty()))
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
        List<CandidateQuestion> questions = questionRepository.findByQuizId(quizId);

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
        List<CandidateQuestion> quizQuestions = questionRepository.findByQuizId(quizId);
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
        List<CandidateQuestion> quizQuestions = questionRepository.findByQuizId(quizId);

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
