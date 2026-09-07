package com.quizbackend.quiz.receipt;

import org.junit.jupiter.api.Test;

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
}
