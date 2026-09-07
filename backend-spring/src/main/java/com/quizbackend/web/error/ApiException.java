package com.quizbackend.web.error;

import org.springframework.http.HttpStatus;

/**
 * The Spring equivalent of the Node reference's {@code ApiError}
 * ({@code backend/src/shared/errors.ts}). Slice 2 added {@code NOT_FOUND}
 * (the only code its two read-only quiz endpoints needed); Slice 3 adds the
 * four more the Interview session create/resume routes need
 * (BAD_REQUEST/UNAUTHORIZED/SESSION_EXPIRED/CONFLICT), with the SAME
 * status-code mapping as Node's {@code STATUS_BY_CODE}. Node's remaining two
 * codes (PAYLOAD_TOO_LARGE, and a bare INTERNAL factory) are still deferred
 * until a route actually needs them.
 */
public final class ApiException extends RuntimeException {

    private final HttpStatus status;
    private final String code;

    private ApiException(HttpStatus status, String code, String message) {
        super(message);
        this.status = status;
        this.code = code;
    }

    public static ApiException notFound(String message) {
        return new ApiException(HttpStatus.NOT_FOUND, "NOT_FOUND", message);
    }

    public static ApiException badRequest(String message) {
        return new ApiException(HttpStatus.BAD_REQUEST, "BAD_REQUEST", message);
    }

    public static ApiException unauthorized(String message) {
        return new ApiException(HttpStatus.UNAUTHORIZED, "UNAUTHORIZED", message);
    }

    /** Same HTTP status as {@link #conflict}, distinct code — matches Node exactly. */
    public static ApiException sessionExpired(String message) {
        return new ApiException(HttpStatus.CONFLICT, "SESSION_EXPIRED", message);
    }

    public static ApiException conflict(String message) {
        return new ApiException(HttpStatus.CONFLICT, "CONFLICT", message);
    }

    public static ApiException internal(String message) {
        return new ApiException(HttpStatus.INTERNAL_SERVER_ERROR, "INTERNAL", message);
    }

    public HttpStatus getStatus() {
        return status;
    }

    public String getCode() {
        return code;
    }
}
