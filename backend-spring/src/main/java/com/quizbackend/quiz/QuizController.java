package com.quizbackend.quiz;

import com.quizbackend.quiz.dto.QuizMetadataDto;
import com.quizbackend.quiz.dto.QuizzesListBody;
import com.quizbackend.security.responsepolicy.ResponsePolicy;
import com.quizbackend.security.responsepolicy.ResponsePolicyContext;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Parity with the Node reference's read-only quiz metadata routes
 * ({@code backend/src/routes/quizzes.route.ts}): {@code GET /quizzes} and
 * {@code GET /quizzes/:quizId}. Both there and here, PUBLIC_METADATA is set
 * FIRST, before any lookup — including the not-found path, so a 404's error
 * body is scanned under the same policy the success path would have used
 * (matching the Node reference, whose error handler never calls
 * {@code setResponsePolicy} itself).
 *
 * <p>Only metadata: neither endpoint returns questions, options, or a
 * {@code codeSnippet} — those live on
 * {@code GET /quizzes/:quizId/questions}, which is explicitly out of scope
 * for this slice.
 */
@RestController
@RequestMapping("/api/quizzes")
public class QuizController {

    private final QuizService quizService;

    public QuizController(QuizService quizService) {
        this.quizService = quizService;
    }

    @GetMapping
    public QuizzesListBody list(HttpServletRequest request) {
        ResponsePolicyContext.set(request, ResponsePolicy.PUBLIC_METADATA);
        return new QuizzesListBody(quizService.listQuizMetadata());
    }

    @GetMapping("/{quizId}")
    public QuizMetadataDto getOne(@PathVariable String quizId, HttpServletRequest request) {
        ResponsePolicyContext.set(request, ResponsePolicy.PUBLIC_METADATA);
        return quizService.getQuizMetadata(quizId);
    }
}
