package com.quizbackend.interview;

/** Port of the Node reference's {@code SessionRepositoryError}. */
public class SessionRepositoryException extends RuntimeException {

    public enum Category {
        VALIDATION, CONSTRAINT, NOT_FOUND, CORRUPT_DATA,
        SESSION_NOT_FOUND, SESSION_NOT_ACTIVE, SESSION_EXPIRED,
        QUESTION_NOT_IN_SESSION, OPTION_NOT_IN_QUESTION, INVALID_SELECTION_COUNT
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
