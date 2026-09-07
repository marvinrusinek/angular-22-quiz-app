package com.quizbackend.web.error;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

/**
 * Writes {@link ApiException} as {@code { error: { code, message } } }, the
 * same envelope the Node reference's {@code createErrorHandler} produces.
 *
 * <p>The response-policy guard filter still scans this body like any other:
 * whatever policy the controller already set via
 * {@code ResponsePolicyContext.set} before throwing remains in effect (this
 * advice does not change it), matching the Node reference, whose error
 * handler likewise never calls {@code setResponsePolicy} itself. Neither
 * {@code code} nor {@code message} is a banned key under any policy.
 */
@RestControllerAdvice
public class ApiExceptionHandler {

    @ExceptionHandler(ApiException.class)
    public ResponseEntity<ApiErrorBody> handleApiException(ApiException ex) {
        return ResponseEntity.status(ex.getStatus()).body(ApiErrorBody.of(ex));
    }
}
