package com.quizbackend.web.error;

import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
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
 *
 * <p>Malformed/unreadable JSON never reaches a controller method at all —
 * {@code @RequestBody} argument resolution fails first — so no
 * {@code ResponsePolicyContext.set} call has run yet either; the guard falls
 * back to {@code ResponsePolicy.DEFAULT} (the strictest), which still permits
 * {@code code}/{@code message}. This mirrors the Node reference exactly:
 * body-parser's JSON syntax errors happen before any route handler runs
 * there too, so Node's {@code setResponsePolicy} is likewise never called
 * for this case.
 */
@RestControllerAdvice
public class ApiExceptionHandler {

    @ExceptionHandler(ApiException.class)
    public ResponseEntity<ApiErrorBody> handleApiException(ApiException ex) {
        return ResponseEntity.status(ex.getStatus()).body(ApiErrorBody.of(ex));
    }

    /**
     * Port of the Node reference's own malformed-JSON branch in
     * {@code createErrorHandler} ({@code backend/src/shared/error-handler.ts}):
     * {@code err instanceof SyntaxError && 'body' in err} &rarr;
     * {@code ApiError.badRequest('Malformed JSON body')}, status 400. Spring's
     * equivalent signal is {@link HttpMessageNotReadableException} — thrown
     * for BOTH genuinely malformed JSON syntax and structurally-wrong JSON
     * (e.g. an array/string/number where an object is expected), since
     * Jackson wraps both failure kinds in the same exception type. Using the
     * SAME code/message for both matches Node, which does not distinguish
     * them either (both are body-parser {@code SyntaxError}s from its
     * perspective).
     *
     * <p>The original Jackson exception (which can quote fragments of the
     * offending body) is never included in the response or logged here —
     * only this fixed message reaches the client, same discipline as every
     * other handler in this class.
     */
    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<ApiErrorBody> handleMalformedJson() {
        ApiException malformed = ApiException.badRequest("Malformed JSON body");
        return ResponseEntity.status(malformed.getStatus()).body(ApiErrorBody.of(malformed));
    }
}
