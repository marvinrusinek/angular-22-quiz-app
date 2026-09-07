package com.quizbackend.interview;

/** Port of the Node reference's {@code SessionServiceError}. */
public class SessionServiceException extends RuntimeException {

    public enum Code {
        BAD_REQUEST, UNAUTHORIZED, SESSION_EXPIRED, CONFLICT, INTERNAL
    }

    private final Code code;

    public SessionServiceException(Code code, String message) {
        super(message);
        this.code = code;
    }

    public Code getCode() {
        return code;
    }

    /** Identical for every authentication failure — see {@code InterviewSessionService#authenticate}. */
    public static SessionServiceException unauthorized() {
        return new SessionServiceException(Code.UNAUTHORIZED, "Invalid session credentials");
    }
}
