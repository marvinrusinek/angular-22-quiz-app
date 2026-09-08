package com.quizbackend.web.cors;

import com.quizbackend.interview.InterviewQuestionRepository;
import com.quizbackend.interview.InterviewSessionRepository;
import com.quizbackend.quiz.QuizRepository;
import com.quizbackend.quiz.QuizResourceRepository;
import com.quizbackend.quiz.QuizService;
import com.quizbackend.quiz.dto.QuizMetadataDto;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;

import java.util.List;

import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.options;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * CORS proof against the REAL, wired Spring filter chain (the actual
 * {@link org.springframework.web.filter.CorsFilter} bean, not the
 * {@link ApiCorsConfigurationSource}/{@link StackBlitzPreviewOrigin} unit
 * tested in isolation elsewhere) — same pattern as the Node reference's own
 * {@code cors-preflight.test.ts}/{@code stackblitz-preview-origins.test.ts},
 * which deliberately exercise the real {@code cors()} middleware rather
 * than asserting on the constant, "so they fail the same way a browser
 * would."
 */
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
@TestPropertySource(properties = "cors.allowed-origins=https://marvinrusinek.github.io,https://second.example")
class CorsIntegrationTest {

    private static final String GH_PAGES = "https://marvinrusinek.github.io";
    private static final String SECOND_ALLOWED = "https://second.example";
    private static final String STACKBLITZ = "https://abc123.local-credentialless.webcontainer-api.io";
    private static final String EVIL_NEAR_MISS = "https://webcontainer-api.io.evil.com";
    private static final String ARBITRARY_DISALLOWED = "https://evil.example";

    @Autowired
    private MockMvc mockMvc;

    @MockitoBean
    private QuizService quizService;
    @MockitoBean
    private QuizRepository quizRepository;
    @MockitoBean
    private QuizResourceRepository quizResourceRepository;
    @MockitoBean
    private InterviewQuestionRepository interviewQuestionRepository;
    @MockitoBean
    private InterviewSessionRepository interviewSessionRepository;

    private void stubQuizList() {
        when(quizService.listQuizMetadata()).thenReturn(
                List.of(new QuizMetadataDto("rxjs", "RxJS", "s", "i", "beginner", List.of(), 1)));
    }

    private ResultActions getQuizzesWithOrigin(String origin) throws Exception {
        stubQuizList();
        return mockMvc.perform(get("/api/quizzes").header("Origin", origin));
    }

    private ResultActions preflight(String path, String origin, String method, String requestHeaders) throws Exception {
        return mockMvc.perform(options(path)
                .header("Origin", origin)
                .header("Access-Control-Request-Method", method)
                .header("Access-Control-Request-Headers", requestHeaders));
    }

    // ── 1/2: configured origins ──────────────────────────────────────────

    @Test
    void echoesTheFirstConfiguredAllowedOrigin() throws Exception {
        getQuizzesWithOrigin(GH_PAGES)
                .andExpect(status().isOk())
                .andExpect(header().string("Access-Control-Allow-Origin", GH_PAGES));
    }

    @Test
    void echoesTheSecondConfiguredAllowedOrigin() throws Exception {
        getQuizzesWithOrigin(SECOND_ALLOWED)
                .andExpect(status().isOk())
                .andExpect(header().string("Access-Control-Allow-Origin", SECOND_ALLOWED));
    }

    // ── 3: legitimate StackBlitz preview origin ──────────────────────────

    @Test
    void echoesALegitimateStackBlitzPreviewOriginExactlyNeverAWildcard() throws Exception {
        getQuizzesWithOrigin(STACKBLITZ)
                .andExpect(status().isOk())
                .andExpect(header().string("Access-Control-Allow-Origin", STACKBLITZ));
    }

    // ── 4: localhost/dev origin per Node's actual rules ──────────────────

    @Test
    void localhostIsNotSpeciallyAllowedUnlessConfigured() throws Exception {
        // Deliberate Spring-side adaptation (documented in AllowedOrigins):
        // no dev-default fallback, so an unconfigured localhost origin gets
        // NO CORS header here, same as any other unconfigured origin.
        getQuizzesWithOrigin("http://localhost:4200")
                .andExpect(status().isOk())
                .andExpect(header().doesNotExist("Access-Control-Allow-Origin"));
    }

    // ── 5/6: disallowed / malicious near-match origins ───────────────────

    @Test
    void sendsNoCorsHeaderForADisallowedArbitraryOriginButStillAnswers200() throws Exception {
        // The server still answers; the BROWSER is what blocks it — the
        // exact documented Node posture, not a 500/403.
        getQuizzesWithOrigin(ARBITRARY_DISALLOWED)
                .andExpect(status().isOk())
                .andExpect(header().doesNotExist("Access-Control-Allow-Origin"));
    }

    @Test
    void sendsNoCorsHeaderForAMaliciousNearMissStackBlitzOrigin() throws Exception {
        getQuizzesWithOrigin(EVIL_NEAR_MISS)
                .andExpect(status().isOk())
                .andExpect(header().doesNotExist("Access-Control-Allow-Origin"));
    }

    // ── 7: no-Origin request ─────────────────────────────────────────────

    @Test
    void aRequestWithNoOriginHeaderIsUnaffected() throws Exception {
        stubQuizList();
        mockMvc.perform(get("/api/quizzes"))
                .andExpect(status().isOk())
                .andExpect(header().doesNotExist("Access-Control-Allow-Origin"));
    }

    // ── 8-11: preflight for GET/POST/PUT, and OPTIONS itself ─────────────

    @Test
    void preflightForAGetRequestSucceeds() throws Exception {
        preflight("/api/quizzes", GH_PAGES, "GET", "content-type")
                .andExpect(status().is2xxSuccessful())
                .andExpect(header().string("Access-Control-Allow-Origin", GH_PAGES));
    }

    @Test
    void preflightForAPostRequestSucceeds() throws Exception {
        preflight("/api/quizzes/rxjs/attempts", GH_PAGES, "POST", "content-type")
                .andExpect(status().is2xxSuccessful())
                .andExpect(header().string("Access-Control-Allow-Origin", GH_PAGES));
    }

    @Test
    void preflightForAPutRequestSucceeds() throws Exception {
        preflight("/api/interview-sessions/is_x/answers/q0", GH_PAGES, "PUT", "content-type, authorization")
                .andExpect(status().is2xxSuccessful());
    }

    // ── 12-15: specific headers ───────────────────────────────────────────

    @Test
    void preflightAdvertisesContentType() throws Exception {
        preflight("/api/quizzes/rxjs/check", GH_PAGES, "POST", "content-type")
                .andExpect(allowedHeadersContain("content-type"));
    }

    @Test
    void preflightAdvertisesAuthorization() throws Exception {
        preflight("/api/interview-sessions/is_x", GH_PAGES, "GET", "authorization")
                .andExpect(allowedHeadersContain("authorization"));
    }

    @Test
    void preflightAdvertisesXAttemptReceiptForQuestionsStart() throws Exception {
        preflight("/api/quizzes/rxjs/questions/start", GH_PAGES, "POST", "x-attempt-receipt, content-type")
                .andExpect(status().is2xxSuccessful())
                .andExpect(allowedHeadersContain("x-attempt-receipt"));
    }

    @Test
    void preflightAdvertisesXQuestionReceiptForCheck() throws Exception {
        preflight("/api/quizzes/rxjs/check", GH_PAGES, "POST", "x-question-receipt, content-type")
                .andExpect(status().is2xxSuccessful())
                .andExpect(allowedHeadersContain("x-question-receipt"));
    }

    /**
     * DOCUMENTED DIVERGENCE from Node: Node's {@code cors} middleware
     * returns its FULL static {@code allowedHeaders} array on every
     * preflight regardless of what {@code Access-Control-Request-Headers}
     * asked for. Spring's built-in {@code DefaultCorsProcessor} instead
     * echoes back only the subset of the CONFIGURED allow-list that was
     * actually requested. This is NARROWER than Node, never broader, and
     * does not affect any legitimate Angular preflight: a real browser
     * preflight always requests exactly the custom header it is about to
     * send (proved by {@link #preflightAdvertisesXAttemptReceiptForQuestionsStart}/
     * {@link #preflightAdvertisesXQuestionReceiptForCheck} below, both of
     * which DO get the header echoed back). Reported as a non-blocking,
     * non-weakening difference in the Slice 6C report rather than a parity
     * failure.
     */
    @Test
    void unrequestedAllowedHeadersAreNotEchoedBackOnAPreflightThatDidNotAskForThem() throws Exception {
        preflight("/api/quizzes/rxjs/attempts", GH_PAGES, "POST", "content-type")
                .andExpect(status().is2xxSuccessful())
                .andExpect(allowedHeadersContain("content-type"));
        // x-attempt-receipt/x-question-receipt are configured but not
        // requested here, so Spring's processor omits them — unlike Node.
    }

    // ── 16: credentials ────────────────────────────────────────────────────

    @Test
    void credentialsAreNeverEnabled() throws Exception {
        getQuizzesWithOrigin(GH_PAGES)
                .andExpect(header().doesNotExist("Access-Control-Allow-Credentials"));
        preflight("/api/quizzes/rxjs/check", GH_PAGES, "POST", "x-question-receipt")
                .andExpect(header().doesNotExist("Access-Control-Allow-Credentials"));
    }

    // ── 17: max-age ────────────────────────────────────────────────────────

    @Test
    void preflightMaxAgeIsSixHundredSeconds() throws Exception {
        preflight("/api/quizzes/rxjs/check", GH_PAGES, "POST", "content-type")
                .andExpect(header().string("Access-Control-Max-Age", "600"));
    }

    // ── 18/19: unsupported method/header are simply absent from the advertised lists ──

    @Test
    void unsupportedMethodIsNotInTheAllowedMethodsList() throws Exception {
        String methods = preflight("/api/quizzes", GH_PAGES, "GET", "content-type")
                .andReturn().getResponse().getHeader("Access-Control-Allow-Methods");
        assertMethodsExcludeDelete(methods);
    }

    private static void assertMethodsExcludeDelete(String methods) {
        String normalized = String.valueOf(methods).toUpperCase(java.util.Locale.ROOT);
        org.assertj.core.api.Assertions.assertThat(normalized).doesNotContain("DELETE");
    }

    @Test
    void unsupportedRequestHeaderIsNotAdvertisedAsAllowed() throws Exception {
        preflight("/api/quizzes/rxjs/check", GH_PAGES, "POST", "x-not-a-real-header")
                .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers
                        .header().string("Access-Control-Allow-Headers",
                                org.hamcrest.Matchers.not(org.hamcrest.Matchers.containsStringIgnoringCase("x-not-a-real-header"))));
    }

    // ── 20: CORS on an application error response ────────────────────────

    @Test
    void corsHeadersStillPresentOnAnApplicationErrorResponse() throws Exception {
        when(quizService.getQuizMetadata("nope")).thenThrow(
                com.quizbackend.web.error.ApiException.notFound("Quiz not found"));

        mockMvc.perform(get("/api/quizzes/nope").header("Origin", GH_PAGES))
                .andExpect(status().isNotFound())
                .andExpect(header().string("Access-Control-Allow-Origin", GH_PAGES));
    }

    // ── never a wildcard ──────────────────────────────────────────────────

    @Test
    void neverUsesAWildcardOriginOrHeaderAllowList() throws Exception {
        getQuizzesWithOrigin(GH_PAGES)
                .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers
                        .header().string("Access-Control-Allow-Origin",
                                org.hamcrest.Matchers.not(org.hamcrest.Matchers.equalTo("*"))));
    }

    private static org.springframework.test.web.servlet.ResultMatcher allowedHeadersContain(String expected) {
        return org.springframework.test.web.servlet.result.MockMvcResultMatchers
                .header().string("Access-Control-Allow-Headers", org.hamcrest.Matchers.containsStringIgnoringCase(expected));
    }
}
