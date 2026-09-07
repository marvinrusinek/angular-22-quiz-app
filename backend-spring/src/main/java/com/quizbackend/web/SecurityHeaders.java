package com.quizbackend.web;

/**
 * The one header name/value this migration currently hardens, shared between
 * {@link SecurityHeadersFilter} (the normal-path writer) and
 * {@code ResponsePolicyGuardFilter} (which must re-apply it after
 * {@code response.reset()} wipes it on a violation). Two constants, not a new
 * abstraction &mdash; kept here only so the literal string is not duplicated.
 */
public final class SecurityHeaders {

    public static final String NOSNIFF_NAME = "X-Content-Type-Options";
    public static final String NOSNIFF_VALUE = "nosniff";

    private SecurityHeaders() {
    }
}
