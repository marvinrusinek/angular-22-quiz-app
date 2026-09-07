package com.quizbackend.web.error;

import org.springframework.http.HttpStatus;

/**
 * The minimal Spring equivalent of the Node reference's {@code ApiError}
 * ({@code backend/src/shared/errors.ts}) &mdash; deliberately only as much of
 * that vocabulary as Slice 2's two read-only quiz endpoints need
 * ({@code NOT_FOUND}). Slice 1 intentionally deferred the full Node-parity
 * error model; this adds one code rather than porting all seven, so later
 * slices extend it as they actually need more codes instead of speculatively
 * pre-building them now.
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

    public HttpStatus getStatus() {
        return status;
    }

    public String getCode() {
        return code;
    }
}
