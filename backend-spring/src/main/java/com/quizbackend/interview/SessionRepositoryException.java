package com.quizbackend.interview;

/** Port of the Node reference's {@code SessionRepositoryError}. */
public class SessionRepositoryException extends RuntimeException {

    public enum Category {
        VALIDATION, CONSTRAINT, NOT_FOUND, CORRUPT_DATA,
        SESSION_NOT_FOUND, SESSION_NOT_ACTIVE, SESSION_EXPIRED,
        QUESTION_NOT_IN_SESSION, OPTION_NOT_IN_QUESTION, INVALID_SELECTION_COUNT,
        /**
         * A concurrent request already committed a session under the SAME
         * idempotency key before this one's INSERT could complete — not a
         * failure, the caller must resolve it by reading back the winner's
         * session (see {@code InterviewSessionService#tryReturnExisting}).
         * Distinguished from the ordinary {@link #CONSTRAINT} case (an
         * astronomically unlikely random session/attempt id collision) so the
         * two are never handled the same way.
         */
        IDEMPOTENCY_KEY_RACE
    }

    private final Category category;

    public SessionRepositoryException(Category category, String message) {
        super(message);
        this.category = category;
    }

    public Category getCategory() {
        return category;
    }
}
