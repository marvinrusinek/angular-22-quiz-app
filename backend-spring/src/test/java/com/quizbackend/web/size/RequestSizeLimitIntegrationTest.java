package com.quizbackend.web.size;

import com.quizbackend.interview.InterviewQuestionRepository;
import com.quizbackend.interview.InterviewSessionRepository;
import com.quizbackend.quiz.QuizRepository;
import com.quizbackend.quiz.QuizResourceRepository;
import com.quizbackend.quiz.topicquiz.TopicQuizService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * Full-stack proof for {@link RequestSizeLimitFilter} through the REAL
 * Spring filter chain (security headers, CORS, response-policy guard, the
 * size filter itself, then the controller) — same pattern as {@code
 * CorsIntegrationTest}. Complements {@code RequestSizeLimitFilterTest}'s
 * precise boundary-byte proofs with the externally observable HTTP
 * contract: status, headers, envelope, and non-invocation of business
 * logic.
 */
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
@TestPropertySource(properties = "cors.allowed-origins=https://marvinrusinek.github.io")
class RequestSizeLimitIntegrationTest {

    private static final String GH_PAGES = "https://marvinrusinek.github.io";
    private static final int LIMIT = RequestSizeLimitFilter.LIMIT_BYTES;

    @Autowired
    private MockMvc mockMvc;

    @MockitoBean
    private TopicQuizService topicQuizService;
    @MockitoBean
    private QuizRepository quizRepository;
    @MockitoBean
    private QuizResourceRepository quizResourceRepository;
    @MockitoBean
    private InterviewQuestionRepository interviewQuestionRepository;
    @MockitoBean
    private InterviewSessionRepository interviewSessionRepository;

    private static String jsonBodyOfExactByteLength(int targetBytes) {
        // {"questionText":"","selectedOptionTexts":[]}  <- fixed scaffold,
        // padded with a filler string inside the value to hit an EXACT
        // total byte length (ASCII only, so char length == byte length).
        String scaffold = "{\"questionText\":\"\",\"selectedOptionTexts\":[]}";
        int padding = targetBytes - scaffold.length();
        if (padding <= 0) {
            return scaffold.substring(0, targetBytes);
        }
        return "{\"questionText\":\"" + "a".repeat(padding) + "\",\"selectedOptionTexts\":[]}";
    }

    @Test
    void oneByteOverTheLimitReturns413BeforeReceiptValidationOrRateLimiting() throws Exception {
        String body = jsonBodyOfExactByteLength(LIMIT + 1);

        mockMvc.perform(post("/api/quizzes/rxjs/check")
                        .header("X-Question-Receipt", "irrelevant-because-never-checked")
                        .contentType("application/json")
                        .content(body))
                .andExpect(status().is(413))
                .andExpect(jsonPath("$.error.code").value("PAYLOAD_TOO_LARGE"))
                .andExpect(jsonPath("$.error.message").value("Request body too large"));

        // The controller/service must never be invoked for an oversized body —
        // proven directly, not merely inferred from the status code.
        verify(topicQuizService, never()).check(anyString(), any(), any(), any(), anyString());
    }

    @Test
    void exactlyAtTheLimitIsAcceptedAndReachesTheController() throws Exception {
        String body = jsonBodyOfExactByteLength(LIMIT);
        assertUtf8Length(body, LIMIT);

        mockMvc.perform(post("/api/quizzes/rxjs/check")
                        .header("X-Question-Receipt", "some-receipt")
                        .contentType("application/json")
                        .content(body))
                // A body exactly AT the limit must not be rejected as too
                // large — it reaches the controller (the mocked service
                // returns its Mockito default rather than a real outcome,
                // so this only asserts "not 413", not a specific success body).
                .andExpect(result -> org.assertj.core.api.Assertions.assertThat(result.getResponse().getStatus())
                        .isNotEqualTo(413));
    }

    @Test
    void securityHeadersArePresentOnA413Response() throws Exception {
        String body = jsonBodyOfExactByteLength(LIMIT + 1);

        mockMvc.perform(post("/api/quizzes/rxjs/check").contentType("application/json").content(body))
                .andExpect(status().is(413))
                .andExpect(header().string("X-Content-Type-Options", "nosniff"))
                .andExpect(header().string("Referrer-Policy", "no-referrer"))
                .andExpect(header().string("Cross-Origin-Resource-Policy", "same-site"))
                .andExpect(header().string("Cache-Control", "no-store"))
                .andExpect(header().string("Pragma", "no-cache"));
    }

    @Test
    void corsHeadersArePresentOnA413ResponseForAnAllowedOrigin() throws Exception {
        String body = jsonBodyOfExactByteLength(LIMIT + 1);

        mockMvc.perform(post("/api/quizzes/rxjs/check")
                        .header("Origin", GH_PAGES)
                        .contentType("application/json")
                        .content(body))
                .andExpect(status().is(413))
                .andExpect(header().string("Access-Control-Allow-Origin", GH_PAGES));
    }

    @Test
    void aSmallMalformedJsonBodyStillReturnsTheExisting400NotA413() throws Exception {
        mockMvc.perform(post("/api/quizzes/rxjs/attempts").contentType("application/json").content("{ not json"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("BAD_REQUEST"))
                .andExpect(jsonPath("$.error.message").value("Malformed JSON body"));
    }

    @Test
    void anOversizedMalformedJsonBodyStillReturns413NotA400() throws Exception {
        // Even syntactically-broken JSON gets the SIZE error first, since
        // the size filter runs before Jackson ever sees the body — matching
        // Node's own ordering (express.json()'s size check happens during
        // body-parsing, before the JSON.parse step that would otherwise
        // produce the SyntaxError branch).
        String garbage = "{ not json " + "x".repeat(LIMIT + 1000);

        mockMvc.perform(post("/api/quizzes/rxjs/attempts").contentType("application/json").content(garbage))
                .andExpect(status().is(413))
                .andExpect(jsonPath("$.error.code").value("PAYLOAD_TOO_LARGE"));
    }

    @Test
    void aNonObjectJsonBodyBelowTheLimitStillGetsTheExistingMalformedBodyHandling() throws Exception {
        mockMvc.perform(post("/api/quizzes/rxjs/attempts").contentType("application/json").content("[1,2,3]"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.message").value("Malformed JSON body"));
    }

    private static void assertUtf8Length(String s, int expectedBytes) {
        org.assertj.core.api.Assertions.assertThat(s.getBytes(java.nio.charset.StandardCharsets.UTF_8).length)
                .isEqualTo(expectedBytes);
    }
}
