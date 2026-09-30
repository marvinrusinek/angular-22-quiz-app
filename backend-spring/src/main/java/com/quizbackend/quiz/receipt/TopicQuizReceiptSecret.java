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
 * <p><b>Known-dev-default rejection (final-audit Issue 3):</b> Node's own
 * {@code parseReceiptSecret} additionally refuses to let {@code
 * DEV_RECEIPT_SECRET} — a FIXED, PUBLIC constant committed in {@code
 * backend/src/config.ts}, deliberately long enough (47 characters) to clear
 * a plain length check — reach production ({@code isProduction &&
 * value === DEV_RECEIPT_SECRET}). This class had no equivalent check: since
 * it has no "production" flag at all (see above), it accepted that exact
 * public value unconditionally, in every profile, as long as it met the
 * length requirement — which it does. Both deploy docs instruct an operator
 * to copy Node's exact configured value into this service's env var; if
 * Node's own value were ever misconfigured to the dev default (e.g. by
 * mistake, or a copy-paste from local `.env`), this bean would have
 * silently accepted it too, and every Topic Quiz receipt this service
 * issues or verifies — including the reveal-gating check — would be
 * forgeable by anyone who has read Node's public source.
 * {@link #KNOWN_NODE_DEV_DEFAULT} is that exact literal, rejected
 * unconditionally (no profile gate — this class already has none), and
 * MUST be kept byte-identical to {@code DEV_RECEIPT_SECRET} in {@code
 * backend/src/config.ts} for this check to mean anything.
 *
 * <p>Never logged, never included in {@link #toString()}, never echoed in
 * an error message — including this one: the constant is compared, never
 * printed, so an error caused by it reveals nothing a reader of Node's own
 * public source does not already know.
 */
@Component
public class TopicQuizReceiptSecret {

    public static final int MIN_LENGTH = 32;

    /**
     * MUST stay byte-identical to {@code DEV_RECEIPT_SECRET} in {@code
     * backend/src/config.ts}. A mismatch here silently reopens the exact gap
     * this class exists to close — this is a direct port of a public value,
     * not a new secret, so keeping the literal in sync manually (rather than
     * sharing it some other way across two independent runtimes/languages)
     * is the same accepted trade-off {@link #MIN_LENGTH} already makes
     * against {@code MIN_RECEIPT_SECRET_LENGTH}.
     */
    public static final String KNOWN_NODE_DEV_DEFAULT = "dev-only-insecure-topic-quiz-receipt-secret-000";

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
        if (value.equals(KNOWN_NODE_DEV_DEFAULT)) {
            throw new IllegalStateException(
                    "TOPIC_QUIZ_RECEIPT_SECRET must not be the publicly known Node development default");
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
