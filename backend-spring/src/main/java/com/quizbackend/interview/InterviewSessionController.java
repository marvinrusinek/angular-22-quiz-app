package com.quizbackend.interview;

import com.quizbackend.interview.dto.ActiveInterviewSessionDto;
import com.quizbackend.security.responsepolicy.ResponsePolicy;
import com.quizbackend.security.responsepolicy.ResponsePolicyContext;
import com.quizbackend.web.error.ApiException;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * Interview session routes — a THIN adapter, mirroring the Node reference's
 * {@code interview-sessions.route.ts}: parses HTTP input, pulls the bearer
 * token, calls the service, selects the response policy, translates known
 * errors. No generation, scoring, token verification or persistence logic
 * lives here. Scoped to create + resume for this slice — there are
 * deliberately no answer/flag/submit/result routes yet.
 */
@RestController
@RequestMapping("/api/interview-sessions")
public class InterviewSessionController {

    private final InterviewSessionService service;

    public InterviewSessionController(InterviewSessionService service) {
        this.service = service;
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public ActiveInterviewSessionDto create(
            @RequestBody(required = false) Map<String, Object> body, HttpServletRequest request) {
        // SESSION_CREATED is ACTIVE_ASSESSMENT plus a token exemption scoped
        // to THIS route. The global ban stays intact, so resume cannot leak it.
        ResponsePolicyContext.set(request, ResponsePolicy.SESSION_CREATED);
        try {
            return service.createSession(body == null ? Map.of() : body);
        } catch (SessionServiceException e) {
            throw translate(e);
        }
    }

    @GetMapping("/{sessionId}")
    public ActiveInterviewSessionDto resume(
            @PathVariable String sessionId,
            @RequestHeader(value = "Authorization", required = false) String authorization,
            HttpServletRequest request) {
        ResponsePolicyContext.set(request, ResponsePolicy.ACTIVE_ASSESSMENT);
        try {
            String token = SessionToken.extractBearerToken(authorization);
            return service.resumeSession(sessionId, token);
        } catch (SessionServiceException e) {
            throw translate(e);
        }
    }

    /** Map service errors onto the shared API error vocabulary — mirrors the Node router's own {@code translate}. */
    private static ApiException translate(SessionServiceException e) {
        return switch (e.getCode()) {
            case BAD_REQUEST -> ApiException.badRequest(e.getMessage());
            // Identical for missing, malformed, unknown-session and wrong token.
            case UNAUTHORIZED -> ApiException.unauthorized("Invalid session credentials");
            case SESSION_EXPIRED -> ApiException.sessionExpired(e.getMessage());
            case CONFLICT -> ApiException.conflict(e.getMessage());
            default -> ApiException.internal("Internal server error");
        };
    }
}
