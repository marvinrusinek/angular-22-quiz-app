package com.quizbackend.quiz.receipt;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Fail-closed proof for {@link TopicQuizReceiptSecret}, isolated from the
 * full application context (which the missing-datasource JAR-startup test
 * in the Slice 6B report also covers, but that conflates multiple failure
 * points — this proves THIS bean's own gate directly and precisely).
 */
class TopicQuizReceiptSecretTest {

    @Test
    void rejectsAnUnsetEmptyValue() {
        assertThatThrownBy(() -> new TopicQuizReceiptSecret(""))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("TOPIC_QUIZ_RECEIPT_SECRET is required");
    }

    @Test
    void rejectsABlankValue() {
        assertThatThrownBy(() -> new TopicQuizReceiptSecret("   "))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("TOPIC_QUIZ_RECEIPT_SECRET is required");
    }

    @Test
    void rejectsANullValue() {
        assertThatThrownBy(() -> new TopicQuizReceiptSecret(null))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("TOPIC_QUIZ_RECEIPT_SECRET is required");
    }

    @Test
    void rejectsAValueShorterThanTheMinimumLength() {
        String tooShort = "x".repeat(TopicQuizReceiptSecret.MIN_LENGTH - 1);
        assertThatThrownBy(() -> new TopicQuizReceiptSecret(tooShort))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("at least " + TopicQuizReceiptSecret.MIN_LENGTH + " characters")
                // Never echoes the supplied value or its actual length.
                .satisfies(ex -> assertThat(ex.getMessage()).doesNotContain(tooShort));
    }

    @Test
    void acceptsAValueAtExactlyTheMinimumLength() {
        String exact = "x".repeat(TopicQuizReceiptSecret.MIN_LENGTH);
        assertThat(new TopicQuizReceiptSecret(exact).value()).isEqualTo(exact);
    }

    @Test
    void toStringNeverExposesTheSecretValue() {
        String secret = "x".repeat(TopicQuizReceiptSecret.MIN_LENGTH);
        assertThat(new TopicQuizReceiptSecret(secret).toString()).doesNotContain(secret);
    }

    // ── Final-audit Issue 3: rejecting Node's known development default ────
    //
    // Node's parseReceiptSecret (backend/src/config.ts) refuses to let its
    // own DEV_RECEIPT_SECRET — a fixed, PUBLIC constant, 47 characters, long
    // enough to clear a plain length check — reach production. This class
    // had no equivalent check and accepted that exact public value
    // unconditionally (it applies the same checks in every profile except
    // `test`, per its own class doc). Both deploy docs instruct an operator
    // to copy Node's configured value into this service's env var, so a
    // misconfigured Node deployment would have silently propagated the same
    // forgeable secret here.

    @Test
    void rejectsNodesKnownDevelopmentDefaultExplicitly() {
        // Explicitly supplying Node's real, committed default (not a look-alike
        // or a synthetic stand-in) must fail Spring's own configuration
        // validation — this is the exact gap the final audit reported.
        assertThat(TopicQuizReceiptSecret.KNOWN_NODE_DEV_DEFAULT.length())
                .as("sanity check: the known default must itself clear the length gate, "
                        + "otherwise this test would pass for the wrong reason")
                .isGreaterThanOrEqualTo(TopicQuizReceiptSecret.MIN_LENGTH);

        assertThatThrownBy(() -> new TopicQuizReceiptSecret(TopicQuizReceiptSecret.KNOWN_NODE_DEV_DEFAULT))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("must not be")
                // Never echoes the rejected value itself, consistent with every
                // other branch in this class.
                .satisfies(ex -> assertThat(ex.getMessage())
                        .doesNotContain(TopicQuizReceiptSecret.KNOWN_NODE_DEV_DEFAULT));
    }

    @Test
    void rejectsTheKnownDefaultUnconditionally_notJustInSomeProfile() {
        // This class has no "production" flag at all (unlike Node's isProduction
        // gate) — the constructor is exercised directly here with no profile in
        // play at all, proving the rejection is NOT conditioned on one.
        assertThatThrownBy(() -> new TopicQuizReceiptSecret(TopicQuizReceiptSecret.KNOWN_NODE_DEV_DEFAULT))
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    void aValidSyntheticSecretDifferentFromTheKnownDefaultIsStillAccepted() {
        // Clearly-labelled, unambiguously not Node's real default — proves the
        // new check is exact-match only and doesn't over-reject real secrets.
        String synthetic = "synthetic-test-only-receipt-secret-not-the-node-default";
        assertThat(new TopicQuizReceiptSecret(synthetic).value()).isEqualTo(synthetic);
    }

    @Test
    void receiptSigningAndVerificationStillWorkWithAValidSharedSyntheticSecret() {
        // Proves the fix doesn't disturb the normal path: a secret that PASSES
        // TopicQuizReceiptSecret's validation (including the new check) must
        // still sign and verify a real receipt end to end, exactly as before.
        String synthetic = "shared-synthetic-secret-for-signing-round-trip-test";
        String secretValue = new TopicQuizReceiptSecret(synthetic).value();

        var signer = new QuestionReceiptSigner(new ReceiptCodec(new ObjectMapper()));
        long startedAt = 1_700_000_000_000L;
        long expiresAt = startedAt + 30_000L;
        var payload = new QuestionReceiptPayload(
                ReceiptCodec.RECEIPT_VERSION, "rxjs", "Is a Subject also an Observable?", startedAt, expiresAt);

        String receipt = signer.issue(payload, secretValue);
        assertThat(signer.verify(receipt, secretValue)).isEqualTo(payload);
    }
}
