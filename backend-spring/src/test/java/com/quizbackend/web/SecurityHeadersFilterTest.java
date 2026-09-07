package com.quizbackend.web;

import com.quizbackend.interview.InterviewQuestionRepository;
import com.quizbackend.interview.InterviewSessionRepository;
import com.quizbackend.quiz.QuizRepository;
import com.quizbackend.quiz.QuizService;
import com.quizbackend.quiz.dto.QuizMetadataDto;
import com.quizbackend.web.error.ApiException;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;

import java.util.List;

import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * Parity proof against the Node reference's
 * {@code backend/src/shared/security-headers.ts}: ALL FIVE headers it sets
 * ({@code X-Content-Type-Options: nosniff}, {@code Referrer-Policy:
 * no-referrer}, {@code Cross-Origin-Resource-Policy: same-site}, {@code
 * Cache-Control: no-store}, {@code Pragma: no-cache}) on every response
 * &mdash; success, 404, and even a response-policy guard block &mdash; not
 * merely on the happy path and not merely the one header the Slice 2
 * correction originally scoped this filter to.
 *
 * <p>{@code QuizRepository} is mocked so this class needs no database (same
 * reasoning as {@code HealthControllerTest}); {@code QuizService} is mocked
 * too so the 404 case can be driven deterministically.
 */
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
class SecurityHeadersFilterTest {

    @Autowired
    private MockMvc mockMvc;

    @MockitoBean
    private QuizRepository quizRepository;

    @MockitoBean
    private QuizService quizService;

    @MockitoBean
    private InterviewQuestionRepository interviewQuestionRepository;

    @MockitoBean
    private InterviewSessionRepository interviewSessionRepository;

    /** Asserts the COMPLETE Node-parity header set, verbatim name/value. */
    private static ResultActions expectAllFiveSecurityHeaders(ResultActions actions) throws Exception {
        return actions
                .andExpect(header().string("X-Content-Type-Options", "nosniff"))
                .andExpect(header().string("Referrer-Policy", "no-referrer"))
                .andExpect(header().string("Cross-Origin-Resource-Policy", "same-site"))
                .andExpect(header().string("Cache-Control", "no-store"))
                .andExpect(header().string("Pragma", "no-cache"));
    }

    @Test
    void healthResponseCarriesAllFiveSecurityHeaders() throws Exception {
        expectAllFiveSecurityHeaders(mockMvc.perform(get("/api/health")))
                .andExpect(status().isOk());
    }

    @Test
    void quizListResponseCarriesAllFiveSecurityHeaders() throws Exception {
        when(quizService.listQuizMetadata()).thenReturn(List.of(
                new QuizMetadataDto("rxjs", "RxJS", "s", "i", "intermediate", List.of(), 9)));

        expectAllFiveSecurityHeaders(mockMvc.perform(get("/api/quizzes")))
                .andExpect(status().isOk());
    }

    @Test
    void quizDetailResponseCarriesAllFiveSecurityHeaders() throws Exception {
        when(quizService.getQuizMetadata("rxjs")).thenReturn(
                new QuizMetadataDto("rxjs", "RxJS", "s", "i", "intermediate", List.of(), 9));

        expectAllFiveSecurityHeaders(mockMvc.perform(get("/api/quizzes/rxjs")))
                .andExpect(status().isOk());
    }

    @Test
    void notFoundErrorResponseCarriesAllFiveSecurityHeaders() throws Exception {
        when(quizService.getQuizMetadata("nonexistent")).thenThrow(ApiException.notFound("Quiz not found"));

        expectAllFiveSecurityHeaders(mockMvc.perform(get("/api/quizzes/nonexistent")))
                .andExpect(status().isNotFound());
    }

    @Test
    void aResponsePolicyGuardBlockedResponseStillCarriesAllFiveSecurityHeaders() throws Exception {
        // RED/GREEN, multi-part proof, all in one request against the real
        // ResponsePolicyProbeController (Slice 1's test-only adversarial
        // controller — never compiled into the production JAR):
        //   1. the probe deliberately returns a forbidden top-level field
        //      (correctOptionIds) under ACTIVE_ASSESSMENT
        //   2. the guard detects it and blocks the response
        //   3. status is 500
        //   4/5. the sanitized body is exactly the fixed envelope, and the
        //      forbidden field/value never reaches the client
        //   6. all five security headers are STILL present — proving
        //      ResponsePolicyGuardFilter's post-reset() re-application of the
        //      COMPLETE SecurityHeaders.ALL set works, not just nosniff.
        //
        // The header is re-applied synchronously inside ResponsePolicyGuardFilter
        // itself, immediately after reset() and before the sanitized body is
        // written — the same write-ordering guarantee already proven reliable
        // on a real server for the normal path (see the real-server
        // verification in the Slice 2 correction report), not a MockMvc-only
        // behavior.
        ResultActions result = mockMvc.perform(get("/test/response-policy/active/forbidden-top-level"))
                .andExpect(status().isInternalServerError())
                .andExpect(content().json("{\"error\":{\"code\":\"INTERNAL\",\"message\":\"Internal server error\"}}"))
                .andExpect(jsonPath("$.correctOptionIds").doesNotExist());
        expectAllFiveSecurityHeaders(result);
    }
}
