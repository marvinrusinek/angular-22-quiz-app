package com.quizbackend.security.responsepolicy.testsupport;

import com.quizbackend.security.responsepolicy.ResponsePolicy;
import com.quizbackend.security.responsepolicy.ResponsePolicyContext;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * TEST-ONLY adversarial endpoints for {@code ResponsePolicyGuardFilterTest}.
 *
 * <p>Lives entirely under {@code src/test/java} &mdash; Maven never compiles
 * test sources into {@code target/classes}, so {@code mvn package} cannot
 * include this controller in the production JAR, and it is never reachable
 * outside a test-context Spring Boot run. This is the deliberate alternative
 * to adding a production {@code /api/test/leak} route.
 *
 * <p>Each endpoint deliberately returns a shape the response-policy guard
 * should either allow or block, so the RED/GREEN tests exercise the guard
 * against real Spring MVC JSON serialization &mdash; not a hand-built JSON
 * string standing in for what a controller might return.
 */
@RestController
public class ResponsePolicyProbeController {

    /** A representative SAFE active-Interview-shaped response. Must pass. */
    @GetMapping("/test/response-policy/active/safe")
    public Map<String, Object> safeActive(HttpServletRequest request) {
        ResponsePolicyContext.set(request, ResponsePolicy.ACTIVE_ASSESSMENT);
        return activeQuestion(Map.of("optionId", 101, "text", "A reactive wrapper around a value"));
    }

    /** A forbidden field at the TOP LEVEL of an active-Interview-shaped response. Must be blocked. */
    @GetMapping("/test/response-policy/active/forbidden-top-level")
    public Map<String, Object> forbiddenTopLevel(HttpServletRequest request) {
        ResponsePolicyContext.set(request, ResponsePolicy.ACTIVE_ASSESSMENT);
        Map<String, Object> body = new LinkedHashMap<>(activeQuestion(
                Map.of("optionId", 101, "text", "A reactive wrapper around a value")));
        // The exact kind of leak this filter exists to catch: an answer-key
        // field accidentally present alongside an otherwise-safe response.
        body.put("correctOptionIds", List.of(101));
        return body;
    }

    /** A forbidden field NESTED inside an option object. Must be blocked — proves recursion, not just top-level scanning. */
    @GetMapping("/test/response-policy/active/forbidden-nested")
    public Map<String, Object> forbiddenNested(HttpServletRequest request) {
        ResponsePolicyContext.set(request, ResponsePolicy.ACTIVE_ASSESSMENT);
        Map<String, Object> unsafeOption = new LinkedHashMap<>();
        unsafeOption.put("optionId", 101);
        unsafeOption.put("text", "A reactive wrapper around a value");
        unsafeOption.put("isCorrect", true);
        return activeQuestion(unsafeOption);
    }

    /** Unauthorized explanation/FET content on an active (pre-submission) response. Must be blocked. */
    @GetMapping("/test/response-policy/active/forbidden-explanation")
    public Map<String, Object> forbiddenExplanation(HttpServletRequest request) {
        ResponsePolicyContext.set(request, ResponsePolicy.ACTIVE_ASSESSMENT);
        Map<String, Object> body = new LinkedHashMap<>(activeQuestion(
                Map.of("optionId", 101, "text", "A reactive wrapper around a value")));
        body.put("explanation", "Because signals are reactive.");
        return body;
    }

    /**
     * A raw {@code Map<String,Object>} (never a declared DTO/record type)
     * carrying a forbidden field. Proves the guard catches a leak from the
     * SERIALIZED structure regardless of the Java return type — defense beyond
     * compile-time type safety, not merely "the record doesn't declare this
     * field".
     */
    @GetMapping("/test/response-policy/active/map-bypass")
    public Map<String, Object> mapBypass(HttpServletRequest request) {
        ResponsePolicyContext.set(request, ResponsePolicy.ACTIVE_ASSESSMENT);
        Map<String, Object> raw = new LinkedHashMap<>();
        raw.put("questionId", "rxjs:q:0");
        raw.put("correct", true); // never named by any Interview DTO — only reachable via a raw map
        return raw;
    }

    /** Post-submit review: correctOptionIds + explanation are AUTHORIZED here. Must pass — proves the policy is scoped, not a blanket ban. */
    @GetMapping("/test/response-policy/submitted-review/safe")
    public Map<String, Object> safeSubmittedReview(HttpServletRequest request) {
        ResponsePolicyContext.set(request, ResponsePolicy.SUBMITTED_REVIEW);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("questionId", "rxjs:q:0");
        body.put("questionText", "What is an Angular Signal?");
        body.put("selectedOptionIds", List.of(101));
        body.put("correctOptionIds", List.of(101));
        body.put("explanation", "Because signals are reactive.");
        body.put("correct", 8); // the AGGREGATE score count — legitimately unbanned under this policy
        return body;
    }

    /** Post-submit review: a PER-OPTION isCorrect flag is still forbidden even here. Must be blocked. */
    @GetMapping("/test/response-policy/submitted-review/forbidden")
    public Map<String, Object> forbiddenSubmittedReview(HttpServletRequest request) {
        ResponsePolicyContext.set(request, ResponsePolicy.SUBMITTED_REVIEW);
        Map<String, Object> option = new LinkedHashMap<>();
        option.put("optionId", 101);
        option.put("text", "A reactive wrapper around a value");
        option.put("isCorrect", true);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("questionId", "rxjs:q:0");
        body.put("options", List.of(option));
        return body;
    }

    /**
     * A representative SAFE quiz-metadata-shaped response — the exact field
     * set {@code QuizController}'s real endpoints emit under PUBLIC_METADATA.
     * Must pass.
     */
    @GetMapping("/test/response-policy/public-metadata/safe")
    public Map<String, Object> safePublicMetadata(HttpServletRequest request) {
        ResponsePolicyContext.set(request, ResponsePolicy.PUBLIC_METADATA);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("quizId", "rxjs");
        body.put("milestone", "RxJS Fundamentals");
        body.put("summary", "Observables, operators and subscriptions.");
        body.put("image", "rxjs.svg");
        body.put("difficulty", "intermediate");
        body.put("facts", List.of("RxJS ships with over 100 operators."));
        body.put("questionCount", 9);
        return body;
    }

    /**
     * A quiz-metadata-shaped response with an accidentally-included
     * {@code explanation} field — answer-key-adjacent content that
     * PUBLIC_METADATA explicitly bans. Must be blocked. Proves the guard
     * protects the ACTUAL policy the Slice 2 quiz endpoints register, not
     * only the Interview-shaped policies exercised above.
     */
    @GetMapping("/test/response-policy/public-metadata/forbidden-explanation")
    public Map<String, Object> forbiddenExplanationOnPublicMetadata(HttpServletRequest request) {
        ResponsePolicyContext.set(request, ResponsePolicy.PUBLIC_METADATA);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("quizId", "rxjs");
        body.put("milestone", "RxJS Fundamentals");
        body.put("questionCount", 9);
        body.put("explanation", "This leaked in by mistake.");
        return body;
    }

    private Map<String, Object> activeQuestion(Map<String, Object> option) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("questionId", "rxjs:q:0");
        body.put("sourceQuizId", "rxjs");
        body.put("questionText", "What is an Angular Signal?");
        body.put("type", "single");
        body.put("options", List.of(option));
        body.put("flagged", false);
        body.put("codeSnippet", Map.of("language", "typescript", "code", "const s = signal(0);"));
        return body;
    }
}
