package com.quizbackend.security.responsepolicy;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * RED/GREEN parity proof for {@link ResponsePolicyGuardFilter} against
 * {@code backend/src/api/response-policy.ts} + {@code response-guard.ts}.
 *
 * <p>Runs against the REAL Spring context with the REAL filter registered
 * ({@code @AutoConfigureMockMvc} wires registered {@code Filter} beans into
 * the MockMvc chain) hitting {@link testsupport.ResponsePolicyProbeController}
 * &mdash; a test-only controller (see its own javadoc) that returns actual
 * Spring-serialized JSON, never a hand-built string standing in for one. Each
 * test name states the exact shape it proves and why that shape matters.
 */
@SpringBootTest
@AutoConfigureMockMvc
class ResponsePolicyGuardFilterTest {

    @Autowired
    private MockMvc mockMvc;

    @Test
    void allowsASafeActiveInterviewShapedResponse() throws Exception {
        // GREEN: questionId/optionId/type/codeSnippet/flagged are all legitimately
        // part of the Interview active contract — the guard must not be so broad
        // it rejects a genuinely safe response.
        mockMvc.perform(get("/test/response-policy/active/safe"))
                .andExpect(status().isOk())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
                .andExpect(jsonPath("$.questionId").value("rxjs:q:0"))
                .andExpect(jsonPath("$.options[0].optionId").value(101))
                .andExpect(jsonPath("$.codeSnippet.language").value("typescript"));
    }

    @Test
    void blocksAForbiddenTopLevelCorrectnessField() throws Exception {
        // RED: correctOptionIds at the top level of an ACTIVE_ASSESSMENT response
        // is exactly the answer-key leak this guard exists to catch.
        mockMvc.perform(get("/test/response-policy/active/forbidden-top-level"))
                .andExpect(status().isInternalServerError())
                .andExpect(jsonPath("$.error.code").value("INTERNAL"))
                .andExpect(jsonPath("$.correctOptionIds").doesNotExist());
    }

    @Test
    void blocksAForbiddenFieldNestedInsideAnOption() throws Exception {
        // RED: proves RECURSION, not just top-level key scanning — isCorrect two
        // levels deep (options[0].isCorrect) must be caught exactly like a
        // top-level occurrence.
        mockMvc.perform(get("/test/response-policy/active/forbidden-nested"))
                .andExpect(status().isInternalServerError())
                .andExpect(jsonPath("$.error.code").value("INTERNAL"))
                .andExpect(jsonPath("$.options").doesNotExist());
    }

    @Test
    void blocksUnauthorizedExplanationOnAnActiveResponse() throws Exception {
        // RED: explanation/FET content must never reach the client before
        // submission — ACTIVE_ASSESSMENT bans it explicitly.
        mockMvc.perform(get("/test/response-policy/active/forbidden-explanation"))
                .andExpect(status().isInternalServerError())
                .andExpect(jsonPath("$.error.code").value("INTERNAL"));
    }

    @Test
    void blocksALeakEvenWhenTheControllerReturnsARawMapInsteadOfADto() throws Exception {
        // RED: this is the defense-beyond-type-safety proof. Nothing about a
        // Map<String,Object> return type stops a "correct" key from being
        // present — only a structural scan of the actual serialized JSON does.
        mockMvc.perform(get("/test/response-policy/active/map-bypass"))
                .andExpect(status().isInternalServerError())
                .andExpect(jsonPath("$.error.code").value("INTERNAL"))
                .andExpect(jsonPath("$.correct").doesNotExist());
    }

    @Test
    void allowsCorrectOptionIdsAndExplanationUnderSubmittedReview() throws Exception {
        // GREEN, and the crucial SCOPING proof: the exact same field names
        // banned above (correctOptionIds, explanation) — plus the aggregate
        // `correct` count — are legitimately authorized once the policy is
        // SUBMITTED_REVIEW. The guard must not globally ban these fields; it
        // must gate them by which route explicitly opted into which policy.
        mockMvc.perform(get("/test/response-policy/submitted-review/safe"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.correctOptionIds[0]").value(101))
                .andExpect(jsonPath("$.explanation").value("Because signals are reactive."))
                .andExpect(jsonPath("$.correct").value(8));
    }

    @Test
    void stillBlocksAPerOptionIsCorrectFlagUnderSubmittedReview() throws Exception {
        // RED: SUBMITTED_REVIEW widens the policy, but it is not "anything
        // goes" — a raw per-option isCorrect flag is still banned; correctness
        // there must be expressed only via the explicit correctOptionIds list.
        mockMvc.perform(get("/test/response-policy/submitted-review/forbidden"))
                .andExpect(status().isInternalServerError())
                .andExpect(jsonPath("$.error.code").value("INTERNAL"));
    }

    @Test
    void healthEndpointIsUnaffectedByTheGuard() throws Exception {
        // GREEN: the guard runs on every request, including the (unrelated,
        // default-policy) health route — proving it is transparent to a
        // response that was never in question, not just to routes that
        // explicitly widen their policy.
        mockMvc.perform(get("/api/health"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("ok"));
    }
}
