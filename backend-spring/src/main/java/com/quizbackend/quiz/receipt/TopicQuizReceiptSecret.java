package com.quizbackend.quiz.receipt;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * The HMAC signing key for Topic Quiz attempt/question receipts. FAILS
 * CLOSED, always: an unset or too-short {@code TOPIC_QUIZ_RECEIPT_SECRET}
 * refuses application startup entirely rather than signing with something
 * guessable or absent.
 *
 * <p>Slice 6B DELIBERATE ADAPTATION from Node's {@code parseReceiptSecret}
 * ({@code backend/src/config.ts}): Node falls back to a clearly-labelled
 * {@code DEV_RECEIPT_SECRET} outside production (gated on {@code
 * NODE_ENV}), and only requires a real secret when {@code isProduction}.
 * This Spring migration has no established "production" flag — Slice 2
 * already chose, for {@code SPRING_DATASOURCE_URL}, to require the value
 * UNCONDITIONALLY with no dev-mode default (see {@code application
 * .properties}), rather than introduce a new environment concept. This
 * class follows that SAME already-reviewed precedent for consistency,
 * rather than inventing a third config posture: the secret is always
 * required from the environment, in every profile except the dedicated
 * {@code test} profile (which overrides it with a clearly-synthetic value
 * in {@code application-test.properties}, exactly like other beans that
 * would otherwise need real infrastructure under test).
 *
 * <p>The minimum-length requirement (32 characters, matching Node's
 * {@code MIN_RECEIPT_SECRET_LENGTH}) is enforced unconditionally, since
 * Node applies it in every environment too — only the "is a value present
 * at all" question is environment-gated in Node, and this class removes
 * that gate rather than weakening the length check.
 *
 * <p>Never logged, never included in {@link #toString()}, never echoed in
 * an error message.
 */
@Component
public class TopicQuizReceiptSecret {

    public static final int MIN_LENGTH = 32;

    private final String value;

    public TopicQuizReceiptSecret(@Value("${topicquiz.receipt-secret:}") String value) {
        if (value == null || value.isBlank()) {
            throw new IllegalStateException(
                    "TOPIC_QUIZ_RECEIPT_SECRET is required — set the environment variable before starting this service.");
        }
        if (value.length() < MIN_LENGTH) {
            // Reports the REQUIRED length only, never the supplied value or its
            // actual length — the latter would narrow a brute-force search.
            throw new IllegalStateException(
                    "TOPIC_QUIZ_RECEIPT_SECRET must be at least " + MIN_LENGTH + " characters");
        }
        this.value = value;
    }

    public String value() {
        return value;
    }

    @Override
    public String toString() {
        return "TopicQuizReceiptSecret[REDACTED]";
    }
}
