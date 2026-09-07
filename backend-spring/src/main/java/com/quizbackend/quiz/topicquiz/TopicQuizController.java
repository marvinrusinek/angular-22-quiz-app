package com.quizbackend.quiz.topicquiz;

import com.quizbackend.quiz.dto.AttemptIssuedDto;
import com.quizbackend.quiz.dto.QuestionStartedDto;
import com.quizbackend.quiz.dto.QuizResourcesBody;
import com.quizbackend.quiz.dto.TopicQuizQuestionsDto;
import com.quizbackend.security.responsepolicy.ResponsePolicy;
import com.quizbackend.security.responsepolicy.ResponsePolicyContext;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * Topic Quiz routes — a THIN adapter, mirroring the Node reference's
 * {@code quizzes.route.ts} receipt-based handlers: parses HTTP input,
 * pulls the receipt headers, calls the service, selects the response
 * policy. No receipt signing/verification, scoring, or persistence logic
 * lives here.
 *
 * <p>Shares the {@code /api/quizzes} base path with {@link
 * com.quizbackend.quiz.QuizController} (metadata) — two controllers, one
 * resource, split by concern exactly as Interview Mode's session lifecycle
 * is its own controller separate from quiz metadata.
 */
@RestController
@RequestMapping("/api/quizzes")
public class TopicQuizController {

    private final TopicQuizService service;

    public TopicQuizController(TopicQuizService service) {
        this.service = service;
    }

    /**
     * Topic Quiz question delivery — no correctness, no explanations, no
     * identifiers of any kind. Not rate-limited: it exposes only text the
     * client is authorized to render.
     */
    @GetMapping("/{quizId}/questions")
    public TopicQuizQuestionsDto questions(@PathVariable String quizId, HttpServletRequest request) {
        ResponsePolicyContext.set(request, ResponsePolicy.QUIZ_QUESTIONS);
        return service.getQuestions(quizId);
    }

    /** The Results-page "Brush up your knowledge" links. PUBLIC_METADATA — these are outbound third-party links, not answer-key material. */
    @GetMapping("/{quizId}/resources")
    public QuizResourcesBody resources(@PathVariable String quizId, HttpServletRequest request) {
        ResponsePolicyContext.set(request, ResponsePolicy.PUBLIC_METADATA);
        return service.getResources(quizId);
    }

    /**
     * Start an attempt. Issues the signed whole-quiz timing receipt. No
     * database state: the receipt IS the attempt record.
     *
     * <p>The body is accepted but never read (Node's own handler never
     * touches {@code req.body} either) — the {@code @RequestBody} parameter
     * exists ONLY so a malformed/non-object JSON body still triggers the
     * standard 400 envelope via Spring's argument resolution, matching
     * Node's global {@code express.json()} middleware, which parses (and
     * can reject) every request body before ANY route handler runs,
     * including this one.
     */
    @PostMapping("/{quizId}/attempts")
    @ResponseStatus(HttpStatus.CREATED)
    public AttemptIssuedDto attempts(
            @PathVariable String quizId,
            @RequestBody(required = false) Map<String, Object> body,
            HttpServletRequest request) {
        ResponsePolicyContext.set(request, ResponsePolicy.ATTEMPT_ISSUED);
        return service.issueAttempt(quizId);
    }

    /** Start ONE question's timer. Issues the signed per-question receipt. Requires a valid attempt receipt for this quiz. */
    @PostMapping("/{quizId}/questions/start")
    @ResponseStatus(HttpStatus.CREATED)
    public QuestionStartedDto start(
            @PathVariable String quizId,
            @RequestHeader(value = "X-Attempt-Receipt", required = false) String attemptReceipt,
            @RequestBody(required = false) Map<String, Object> body,
            HttpServletRequest request) {
        ResponsePolicyContext.set(request, ResponsePolicy.ATTEMPT_ISSUED);
        Object questionText = body == null ? null : body.get("questionText");
        return service.startQuestion(quizId, attemptReceipt, questionText);
    }

    /**
     * Check ONE question's answer and, when the question is terminal,
     * reveal that question's correct options and explanation. The ONLY
     * place correctness leaves the server, and it leaves one question at a
     * time. Rate-limited by client address — see {@link
     * com.quizbackend.quiz.ratelimit.CheckRateLimiter}.
     */
    @PostMapping("/{quizId}/check")
    public CheckOutcome check(
            @PathVariable String quizId,
            @RequestHeader(value = "X-Question-Receipt", required = false) String questionReceipt,
            @RequestBody(required = false) Map<String, Object> body,
            HttpServletRequest request) {
        ResponsePolicyContext.set(request, ResponsePolicy.ANSWER_REVEAL);
        Object questionText = body == null ? null : body.get("questionText");
        Object selectedOptionTexts = body == null ? null : body.get("selectedOptionTexts");
        return service.check(quizId, questionReceipt, questionText, selectedOptionTexts, request.getRemoteAddr());
    }
}
