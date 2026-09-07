package com.quizbackend.quiz.receipt;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Cross-language + structural proof for {@link QuestionReceiptSigner} —
 * port of the Node reference's {@code question-receipt.ts}.
 *
 * <p><b>Cross-language byte parity</b>: {@link #EXPECTED_NODE_RECEIPT} and
 * {@link #EXPECTED_NODE_RECEIPT_UNICODE} were captured by ACTUALLY RUNNING
 * Node's compiled {@code issueQuestionReceipt} (backend/dist/src/quiz/
 * question-receipt.js) against fixed synthetic payloads in this session —
 * not reimplemented or guessed. The unicode vector specifically proves
 * Java's UTF-8 JSON serialization of an em dash and accented characters in
 * {@code questionText} produces byte-identical output to Node's, which
 * matters because the HMAC signs the UTF-8 bytes of the JSON string.
 */
class QuestionReceiptSignerTest {

    private static final String SECRET = "test-secret-at-least-thirty-two-chars-long";
    private static final String OTHER_SECRET = "a-completely-different-secret-also-long-enough";
    private static final long STARTED = 1_700_000_000_000L;
    private static final long EXPIRES = STARTED + 30_000L;

    /** payload {v:1,quizId:'rxjs',questionText:'Which answer is correct?',startedAt:STARTED,expiresAt:EXPIRES}. */
    private static final String EXPECTED_NODE_RECEIPT =
            "eyJ2IjoxLCJxdWl6SWQiOiJyeGpzIiwicXVlc3Rpb25UZXh0IjoiV2hpY2ggYW5zd2VyIGlzIGNvcnJlY3Q_Iiwic3RhcnRlZEF0IjoxNzAwMDAwMDAwMDAwLCJleHBpcmVzQXQiOjE3MDAwMDAwMzAwMDB9"
                    + ".DoceVhScPjAGpRWGvwOaJdqW3tAvcP1ZvLYlRFMrkn0";

    /** payload {v:1,quizId:'rxjs',questionText:'Does café — naïve survive?',startedAt:STARTED,expiresAt:EXPIRES}. */
    private static final String EXPECTED_NODE_RECEIPT_UNICODE =
            "eyJ2IjoxLCJxdWl6SWQiOiJyeGpzIiwicXVlc3Rpb25UZXh0IjoiRG9lcyBjYWbDqSDigJQgbmHDr3ZlIHN1cnZpdmU_Iiwic3RhcnRlZEF0IjoxNzAwMDAwMDAwMDAwLCJleHBpcmVzQXQiOjE3MDAwMDAwMzAwMDB9"
                    + ".RvqVUqmArUaVuw9fBofUnDO8jJHeBvqECMTuJ5m68jg";

    private final QuestionReceiptSigner signer = new QuestionReceiptSigner(new ReceiptCodec(new ObjectMapper()));

    private static QuestionReceiptPayload payload(String questionText) {
        return new QuestionReceiptPayload(ReceiptCodec.RECEIPT_VERSION, "rxjs", questionText, STARTED, EXPIRES);
    }

    @Test
    void issuedReceiptIsByteIdenticalToTheRealNodeImplementation() {
        assertThat(signer.issue(payload("Which answer is correct?"), SECRET)).isEqualTo(EXPECTED_NODE_RECEIPT);
    }

    @Test
    void issuedReceiptWithUnicodeQuestionTextIsByteIdenticalToNode() {
        assertThat(signer.issue(payload("Does café — naïve survive?"), SECRET))
                .isEqualTo(EXPECTED_NODE_RECEIPT_UNICODE);
    }

    @Test
    void aRealNodeIssuedReceiptVerifiesSuccessfullyAgainstTheSpringSigner() {
        assertThat(signer.verify(EXPECTED_NODE_RECEIPT, SECRET)).isEqualTo(payload("Which answer is correct?"));
        assertThat(signer.verify(EXPECTED_NODE_RECEIPT_UNICODE, SECRET))
                .isEqualTo(payload("Does café — naïve survive?"));
    }

    @Test
    void roundTripsAValidReceipt() {
        String receipt = signer.issue(payload("Is a Subject also an Observable?"), SECRET);
        assertThat(signer.verify(receipt, SECRET)).isEqualTo(payload("Is a Subject also an Observable?"));
    }

    @Test
    void rejectsATamperedSignature() {
        String receipt = signer.issue(payload("x"), SECRET);
        String[] parts = receipt.split("\\.");
        char flipped = parts[1].charAt(0) == 'A' ? 'B' : 'A';
        assertThatThrownBy(() -> signer.verify(parts[0] + "." + flipped + parts[1].substring(1), SECRET))
                .isInstanceOf(QuestionReceiptException.class);
    }

    @Test
    void rejectsAReceiptSignedWithADifferentSecret() {
        String receipt = signer.issue(payload("x"), OTHER_SECRET);
        assertThatThrownBy(() -> signer.verify(receipt, SECRET)).isInstanceOf(QuestionReceiptException.class);
    }

    @Test
    void rejectsABlankQuestionText() {
        var codec = new ReceiptCodec(new ObjectMapper());
        java.util.LinkedHashMap<String, Object> raw = new java.util.LinkedHashMap<>();
        raw.put("v", 1);
        raw.put("quizId", "rxjs");
        raw.put("questionText", "   ");
        raw.put("startedAt", STARTED);
        raw.put("expiresAt", EXPIRES);
        String receipt = codec.encodeSignedReceipt(raw, SECRET);
        assertThatThrownBy(() -> signer.verify(receipt, SECRET)).isInstanceOf(QuestionReceiptException.class);
    }

    @Test
    void rejectsExpiresAtNotAfterStartedAt() {
        var codec = new ReceiptCodec(new ObjectMapper());
        java.util.LinkedHashMap<String, Object> raw = new java.util.LinkedHashMap<>();
        raw.put("v", 1);
        raw.put("quizId", "rxjs");
        raw.put("questionText", "x");
        raw.put("startedAt", STARTED);
        raw.put("expiresAt", STARTED);
        String receipt = codec.encodeSignedReceipt(raw, SECRET);
        assertThatThrownBy(() -> signer.verify(receipt, SECRET)).isInstanceOf(QuestionReceiptException.class);
    }

    @Test
    void malformedReceiptsAreRejectedUniformly() {
        for (String malformed : new String[] { "", "abcdef", "a.b.c", ".sig", "payload." }) {
            assertThatThrownBy(() -> signer.verify(malformed, SECRET)).isInstanceOf(QuestionReceiptException.class);
        }
    }
}
