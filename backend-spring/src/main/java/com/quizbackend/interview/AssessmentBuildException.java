package com.quizbackend.interview;

/**
 * Port of the Node reference's {@code AssessmentBuildError}. Diagnostics may
 * name a topic id, a difficulty, counts and a position — never question
 * text, option text, explanations, or correctness.
 */
public class AssessmentBuildException extends RuntimeException {

    public enum Code {
        INVALID_CONFIG,
        UNKNOWN_TOPIC,
        TOPIC_DIFFICULTY_MISMATCH,
        INSUFFICIENT_QUESTIONS,
        INVALID_GENERATED_SNAPSHOT
    }

    private final Code code;

    public AssessmentBuildException(Code code, String message) {
        super(message);
        this.code = code;
    }

    public Code getCode() {
        return code;
    }
}
