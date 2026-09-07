package com.quizbackend.web;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.Map;

/**
 * Response hardening &mdash; parity with the Node reference's {@code
 * backend/src/shared/security-headers.ts}, which sets FIVE headers via one
 * global {@code app.use(securityHeaders)} registered before any route:
 * every Node response, success or error, carries all five. This filter
 * reproduces that same scope: it runs for every request, with no URL pattern
 * restriction, and writes every entry in {@link SecurityHeaders#ALL}.
 *
 * <p>Slice 6 correction: the Slice 2 version of this filter deliberately set
 * only {@code X-Content-Type-Options}, deferring {@code Referrer-Policy},
 * {@code Cross-Origin-Resource-Policy}, {@code Cache-Control} and {@code
 * Pragma}. Re-reading Node's source fresh during the Slice 6 parity audit
 * confirmed those four are set unconditionally alongside nosniff, so they are
 * now ported too &mdash; same header set, same values, same "every response"
 * scope.
 *
 * <p>Deliberately NOT Spring Security &mdash; that would be a large
 * dependency pulled in for five static headers.
 *
 * <p>The headers are written BEFORE {@code filterChain.doFilter(...)} runs
 * (pre-processing), not after. An earlier version of this filter set its one
 * header afterward, on the theory that running outside
 * {@link ResponsePolicyGuardFilter} in the chain (see the {@code @Order}
 * below) would let it survive that filter's {@code response.reset()} on a
 * violation. That passed under MockMvc but FAILED against a real running
 * server: MockMvc's fake response never truly "commits", so a header set
 * after the body was already written is silently accepted there but silently
 * DROPPED by a real Tomcat response once it has committed &mdash; verified by
 * curling the actual packaged JAR, where the header was entirely absent
 * despite every MockMvc test passing. Setting headers before the chain runs
 * guarantees they are present on the real response before anything
 * downstream can write to (and commit) it.
 *
 * <p>That still leaves {@link ResponsePolicyGuardFilter}'s {@code
 * response.reset()}-on-violation path, which clears whatever this filter
 * set. Rather than trying to make THIS filter survive a reset it has no
 * visibility into, {@code ResponsePolicyGuardFilter} re-applies every entry
 * in {@link SecurityHeaders#ALL} itself, synchronously, after its own reset
 * and before writing the sanitized body &mdash; the same before-the-write
 * timing this filter relies on, applied at the one other place in the
 * application that ever clears headers. See that filter's {@code
 * doFilterInternal} for the actual re-application.
 *
 * @see com.quizbackend.security.responsepolicy.ResponsePolicyGuardFilter
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class SecurityHeadersFilter extends OncePerRequestFilter {

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain filterChain)
            throws ServletException, IOException {
        for (Map.Entry<String, String> header : SecurityHeaders.ALL) {
            response.setHeader(header.getKey(), header.getValue());
        }
        filterChain.doFilter(request, response);
    }
}
