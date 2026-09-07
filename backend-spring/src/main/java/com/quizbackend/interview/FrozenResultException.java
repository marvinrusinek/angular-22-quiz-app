package com.quizbackend.interview;

/** Port of the Node reference's {@code FrozenResultError}. */
public class FrozenResultException extends RuntimeException {
    public FrozenResultException(String message) {
        super(message);
    }
}
