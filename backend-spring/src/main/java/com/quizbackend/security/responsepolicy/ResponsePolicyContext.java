package com.quizbackend.security.responsepolicy;

import jakarta.servlet.http.HttpServletRequest;

/**
 * Lets a controller opt its response into a wider policy than the default,
 * mirroring the Node reference's {@code setResponsePolicy(res, policy)}.
 *
 * <p>Stored as a request attribute rather than a {@code ThreadLocal}: it is
 * naturally request-scoped, requires no manual cleanup, and is readable by
 * {@code ResponsePolicyGuardFilter} after {@code filterChain.doFilter()}
 * returns because it is the same {@link HttpServletRequest} instance the
 * controller was handed. A controller that never calls {@link #set} gets
 * {@link ResponsePolicy#DEFAULT} &mdash; explicit widening only, exactly like
 * the Node original.
 */
public final class ResponsePolicyContext {

    private static final String ATTRIBUTE_NAME = ResponsePolicyContext.class.getName() + ".policy";

    private ResponsePolicyContext() {
    }

    public static void set(HttpServletRequest request, ResponsePolicy policy) {
        request.setAttribute(ATTRIBUTE_NAME, policy);
    }

    public static ResponsePolicy resolve(HttpServletRequest request) {
        Object stored = request.getAttribute(ATTRIBUTE_NAME);
        return stored instanceof ResponsePolicy policy ? policy : ResponsePolicy.DEFAULT;
    }
}
