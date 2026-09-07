package com.quizbackend.security.responsepolicy;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Pure unit-level parity proof against {@code response-policy.test.ts}: key
 * normalization + recursive detection, with no Spring context and no HTTP
 * involved. {@link ResponsePolicyGuardFilterTest} covers the same policies
 * end-to-end through real Spring MVC serialization; this class isolates the
 * scanning logic itself so a failure here points straight at the algorithm,
 * not at servlet plumbing.
 */
class ResponsePolicyScannerTest {

    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void keyNormalizationCollapsesNamingDrift() {
        assertThat(ResponsePolicy.ACTIVE_ASSESSMENT.isBanned("is_correct")).isTrue();
        assertThat(ResponsePolicy.ACTIVE_ASSESSMENT.isBanned("isCorrect")).isTrue();
        assertThat(ResponsePolicy.ACTIVE_ASSESSMENT.isBanned("IsCorrect")).isTrue();
        assertThat(ResponsePolicy.ACTIVE_ASSESSMENT.isBanned("is-correct")).isTrue();
    }

    @Test
    void matchingIsExactNeverSubstring() {
        // correctOptionIds must stay distinct from correct — banning one must
        // not accidentally ban the other via a substring match.
        assertThat(ResponsePolicy.SUBMITTED_REVIEW.isBanned("correct")).isFalse();
        assertThat(ResponsePolicy.SUBMITTED_REVIEW.isBanned("isCorrect")).isTrue();
    }

    @Test
    void blocksATopLevelBannedKey() throws Exception {
        JsonNode body = mapper.readTree("{\"correct\":true}");
        Optional<PolicyViolation> violation = ResponsePolicyScanner.scan(body, ResponsePolicy.ACTIVE_ASSESSMENT);
        assertThat(violation).isPresent();
        assertThat(violation.get().key()).isEqualTo("correct");
        assertThat(violation.get().path()).isEqualTo("correct");
    }

    @Test
    void blocksAKeyNestedInsideAnObject() throws Exception {
        JsonNode body = mapper.readTree("{\"nested\":{\"correct\":true}}");
        Optional<PolicyViolation> violation = ResponsePolicyScanner.scan(body, ResponsePolicy.ACTIVE_ASSESSMENT);
        assertThat(violation).isPresent();
        assertThat(violation.get().path()).isEqualTo("nested.correct");
    }

    @Test
    void blocksAKeyInsideAnObjectInsideAnArray() throws Exception {
        JsonNode body = mapper.readTree("{\"items\":[{\"explanation\":\"private\"}]}");
        Optional<PolicyViolation> violation = ResponsePolicyScanner.scan(body, ResponsePolicy.ACTIVE_ASSESSMENT);
        assertThat(violation).isPresent();
        assertThat(violation.get().path()).isEqualTo("items[0].explanation");
    }

    @Test
    void allowsACleanBody() throws Exception {
        JsonNode body = mapper.readTree("""
                {"questions":[{"questionId":"rxjs:q:0","options":[{"optionId":101,"text":"a"}]}]}""");
        assertThat(ResponsePolicyScanner.scan(body, ResponsePolicy.ACTIVE_ASSESSMENT)).isEmpty();
    }

    @Test
    void inspectsNamesNotValuesSafeTextContainingBannedWordsPasses() throws Exception {
        JsonNode body = mapper.readTree("""
                {"questionText":"Which answer is correct?","summary":"Read the explanation to see the correct answer key."}""");
        assertThat(ResponsePolicyScanner.scan(body, ResponsePolicy.ACTIVE_ASSESSMENT)).isEmpty();
    }

    @Test
    void submittedReviewAllowsCorrectOptionIdsAndExplanationButNotPerOptionIsCorrect() throws Exception {
        JsonNode safe = mapper.readTree("""
                {"correctOptionIds":[101],"explanation":"ok"}""");
        assertThat(ResponsePolicyScanner.scan(safe, ResponsePolicy.SUBMITTED_REVIEW)).isEmpty();

        JsonNode unsafe = mapper.readTree("""
                {"options":[{"optionId":101,"isCorrect":true}]}""");
        Optional<PolicyViolation> violation = ResponsePolicyScanner.scan(unsafe, ResponsePolicy.SUBMITTED_REVIEW);
        assertThat(violation).isPresent();
        assertThat(violation.get().key()).isEqualTo("isCorrect");
    }

    @Test
    void policySeparationSameBodyBlockedActiveAllowedSubmitted() throws Exception {
        JsonNode body = mapper.readTree("""
                {"correctOptionIds":[101],"explanation":"why"}""");
        assertThat(ResponsePolicyScanner.scan(body, ResponsePolicy.ACTIVE_ASSESSMENT)).isPresent();
        assertThat(ResponsePolicyScanner.scan(body, ResponsePolicy.SUBMITTED_REVIEW)).isEmpty();
    }
}
