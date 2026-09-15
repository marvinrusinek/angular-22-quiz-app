package com.quizbackend.web.error;

import com.quizbackend.interview.InterviewQuestionRepository;
import com.quizbackend.interview.InterviewSessionRepository;
import com.quizbackend.interview.InterviewSessionService;
import com.quizbackend.interview.SessionServiceException;
import com.quizbackend.quiz.QuizRepository;
import com.quizbackend.quiz.QuizResourceRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.options;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * PROVES what {@link ApiExceptionHandler}'s exception handling actually does
 * to ordinary framework-generated HTTP semantics — routing (404), method
 * mismatch (405), unsupported media type (415), payload-size rejection
 * (413), CORS preflight, and the app's own already-established error
 * contracts (malformed JSON, missing auth, domain exceptions) — as opposed
 * to assuming any of them still behave correctly. Written BEFORE deciding
 * whether a global {@code @ExceptionHandler(Exception.class)} is safe to
 * keep: a broad catch-all can silently convert a legitimate framework 4xx
 * into a 500, and the only way to know is to ask the real, wired
 * {@link org.springframework.web.servlet.DispatcherServlet} exception-
 * resolver chain, not to reason about it in the abstract.
 *
 * <p>Bean Validation ({@code @Valid}/{@code @Validated}) is deliberately NOT
 * covered here: a repo-wide search found zero usages anywhere in {@code
 * backend-spring/src/main/java} — every request body in this codebase is a
 * raw {@code Map<String,Object>} validated by hand in the service layer, so
 * there is no {@code MethodArgumentNotValidException} failure mode that
 * exists to test.
 */
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
@TestPropertySource(properties = "cors.allowed-origins=https://marvinrusinek.github.io")
class ApiExceptionHandlerHttpSemanticsTest {

    @Autowired
    private MockMvc mockMvc;

    @MockitoBean
    private InterviewSessionService service;
    @MockitoBean
    private QuizRepository quizRepository;
    @MockitoBean
    private InterviewQuestionRepository interviewQuestionRepository;
    @MockitoBean
    private InterviewSessionRepository interviewSessionRepository;
    @MockitoBean
    private QuizResourceRepository quizResourceRepository;

    /** The {@code {error:{...}}} envelope is what a MASKED 500 looks like — every assertion below checks its ABSENCE. */
    private static void assertNotMaskedAsInternalError(org.springframework.test.web.servlet.ResultActions result) throws Exception {
        result.andExpect(jsonPath("$.error.code").doesNotExist());
    }

    @Test
    void unknownRouteReturns404NotA500() throws Exception {
        assertNotMaskedAsInternalError(
                mockMvc.perform(get("/api/this-route-does-not-exist"))
                        .andExpect(status().isNotFound()));
    }

    @Test
    void getOnAPostOnlyRouteReturns405NotA500() throws Exception {
        // /api/interview-sessions only maps POST (create); GET on the collection itself has no handler.
        assertNotMaskedAsInternalError(
                mockMvc.perform(get("/api/interview-sessions"))
                        .andExpect(status().isMethodNotAllowed()));
    }

    @Test
    void unsupportedContentTypeReturns415NotA500() throws Exception {
        assertNotMaskedAsInternalError(
                mockMvc.perform(post("/api/interview-sessions")
                                .contentType("text/plain")
                                .content("mode=preset&presetId=junior"))
                        .andExpect(status().isUnsupportedMediaType()));
    }

    @Test
    void malformedJsonKeepsTheExistingBadRequestContract() throws Exception {
        mockMvc.perform(post("/api/interview-sessions")
                        .contentType("application/json")
                        .content("{not valid json"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("BAD_REQUEST"))
                .andExpect(jsonPath("$.error.message").value("Malformed JSON body"));
    }

    @Test
    void missingAuthorizationHeaderKeepsTheExistingUnauthorizedContract() throws Exception {
        when(service.resumeSession(org.mockito.ArgumentMatchers.eq("is_abc123"), org.mockito.ArgumentMatchers.eq(null)))
                .thenThrow(SessionServiceException.unauthorized());

        mockMvc.perform(get("/api/interview-sessions/is_abc123"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("UNAUTHORIZED"));
    }

    @Test
    void oversizedJsonBodyReturns413NotA500() throws Exception {
        // The RequestSizeLimitFilter runs BEFORE the DispatcherServlet and writes its
        // own response directly — this proves that stays true regardless of what
        // ApiExceptionHandler does, since a masked 500 would show the {error:{...}}
        // envelope instead of RequestSizeLimitFilter's own fixed PAYLOAD_TOO_LARGE body.
        String oversized = "{\"padding\":\"" + "x".repeat(40_000) + "\"}";
        mockMvc.perform(post("/api/interview-sessions").contentType("application/json").content(oversized))
                .andExpect(status().isPayloadTooLarge())
                .andExpect(jsonPath("$.error.code").value("PAYLOAD_TOO_LARGE"));
    }

    @Test
    void corsPreflightForAnAllowedOriginIsUnaffected() throws Exception {
        mockMvc.perform(options("/api/interview-sessions")
                        .header("Origin", "https://marvinrusinek.github.io")
                        .header("Access-Control-Request-Method", "POST"))
                .andExpect(status().isOk())
                .andExpect(header().string("Access-Control-Allow-Origin", "https://marvinrusinek.github.io"));
    }

    @Test
    void corsPreflightForADisallowedOriginIsUnaffected() throws Exception {
        mockMvc.perform(options("/api/interview-sessions")
                        .header("Origin", "https://evil.example")
                        .header("Access-Control-Request-Method", "POST"))
                .andExpect(header().doesNotExist("Access-Control-Allow-Origin"));
    }

    @Test
    void anExistingNamedDomainExceptionKeepsItsOwnCodeStatusAndMessage() throws Exception {
        when(service.createSession(org.mockito.ArgumentMatchers.anyMap(), org.mockito.ArgumentMatchers.any()))
                .thenThrow(new SessionServiceException(SessionServiceException.Code.BAD_REQUEST,
                        "mode must be \"preset\" or \"custom\""));

        mockMvc.perform(post("/api/interview-sessions").contentType("application/json").content("{}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("BAD_REQUEST"))
                .andExpect(jsonPath("$.error.message").value("mode must be \"preset\" or \"custom\""));
    }
}
