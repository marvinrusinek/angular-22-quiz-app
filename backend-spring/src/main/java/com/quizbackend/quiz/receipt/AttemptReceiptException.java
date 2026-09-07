package com.quizbackend.quiz.receipt;

/** Port of the Node reference's {@code AttemptReceiptError}. Always the same message — see {@link AttemptReceiptSigner}. */
public class AttemptReceiptException extends RuntimeException {
    public AttemptReceiptException() {
        super("Invalid attempt receipt");
    }
}
