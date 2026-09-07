package com.quizbackend.quiz.receipt;

/** Port of the Node reference's {@code QuestionReceiptError}. Always the same message. */
public class QuestionReceiptException extends RuntimeException {
    public QuestionReceiptException() {
        super("Invalid question receipt");
    }
}
