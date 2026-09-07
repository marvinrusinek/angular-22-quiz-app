package com.quizbackend.web.error;

/**
 * The one error-response shape, parity with the Node reference's
 * {@code ApiErrorBody}: {@code { error: { code, message } } }.
 */
public record ApiErrorBody(ApiErrorDetail error) {

    public record ApiErrorDetail(String code, String message) {
    }

    public static ApiErrorBody of(ApiException ex) {
        return new ApiErrorBody(new ApiErrorDetail(ex.getCode(), ex.getMessage()));
    }
}
