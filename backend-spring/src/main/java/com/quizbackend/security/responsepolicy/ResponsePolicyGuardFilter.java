package com.quizbackend.security.responsepolicy;

import com.quizbackend.web.SecurityHeaders;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.util.ContentCachingResponseWrapper;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Optional;

/**
 * Enforces the response policy on the ACTUAL SERIALIZED response bytes &mdash;
 * the Spring equivalent of the Node reference's {@code createResponseGuard()}
 * (which patches {@code res.json} per-request).
 *
 * <p>A DTO-only guarantee is insufficient: it only protects the response
 * shapes a developer remembered to build carefully. This filter instead
 * buffers the real response via {@link ContentCachingResponseWrapper}, lets
 * the controller/serializer run to completion untouched, and only AFTER that
 * parses the buffered JSON bytes into a tree and scans property names
 * recursively. It therefore catches a leak regardless of whether it came from
 * the intended DTO, an accidentally-returned entity, a raw {@code Map}, or a
 * nested object a future refactor introduced &mdash; the same structural
 * guarantee the Node middleware provides by intercepting the actual
 * {@code res.json} call rather than trusting the caller's declared type.
 *
 * <p>Runs for every request (registered as a normal Spring bean, no URL
 * pattern restriction) &mdash; exactly like the Node guard, which is installed
 * before every route so a route cannot opt out by forgetting a helper. A
 * controller that never calls {@link ResponsePolicyContext#set} is scanned
 * under {@link ResponsePolicy#DEFAULT}, the strictest policy.
 *
 * <p>Explicitly ordered AFTER {@code Ordered.HIGHEST_PRECEDENCE} so
 * {@code com.quizbackend.web.SecurityHeadersFilter} sits OUTSIDE this filter
 * in the chain and sets {@code X-Content-Type-Options} before this filter
 * runs. On a violation this filter's own {@code response.reset()} clears
 * that header along with everything else &mdash; see
 * {@code SecurityHeadersFilter}'s javadoc for the pre-chain-placement
 * reasoning. This filter re-applies {@link SecurityHeaders#NOSNIFF_NAME}
 * itself immediately after {@code reset()} and before writing the sanitized
 * body (see {@link #doFilterInternal}), using the same before-the-write
 * timing that makes header-setting reliable on a real server rather than
 * only under MockMvc.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 10)
public class ResponsePolicyGuardFilter extends OncePerRequestFilter {

    private static final Logger log = LoggerFactory.getLogger(ResponsePolicyGuardFilter.class);

    private static final byte[] BLOCKED_BODY = """
            {"error":{"code":"INTERNAL","message":"Internal server error"}}""".getBytes(StandardCharsets.UTF_8);

    private final ObjectMapper objectMapper;

    public ResponsePolicyGuardFilter(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain filterChain)
            throws ServletException, IOException {

        ContentCachingResponseWrapper wrapped = new ContentCachingResponseWrapper(response);

        filterChain.doFilter(request, wrapped);

        byte[] body = wrapped.getContentAsByteArray();
        String contentType = wrapped.getContentType();

        if (body.length == 0 || !isJson(contentType)) {
            // Nothing to scan (empty body, or not JSON at all) — pass through untouched.
            wrapped.copyBodyToResponse();
            return;
        }

        ResponsePolicy policy = ResponsePolicyContext.resolve(request);
        Optional<PolicyViolation> violation = scanQuietly(body, policy);

        if (violation.isEmpty()) {
            wrapped.copyBodyToResponse();
            return;
        }

        PolicyViolation found = violation.get();
        // Log the ROUTE, POLICY and KEY NAME only — never the value, never the
        // body. Logging the payload here would recreate the exact leak this
        // filter exists to prevent.
        log.error("[response-policy] blocked {} {} — policy {} forbids property \"{}\" at {}",
                request.getMethod(), request.getRequestURI(), found.policy(), found.key(), found.path());

        // The buffered (unsafe) body is discarded entirely — it was never
        // written to the real, unwrapped response, so nothing more than
        // writing the substitute body below is needed to keep it from the
        // client. A blocked body is a server fault, not whatever status the
        // controller intended, so the caller must never see a 200 (or any
        // controller-chosen status) carrying a substitute payload either.
        response.reset();
        // reset() clears every header set earlier in the chain, including
        // X-Content-Type-Options (set by SecurityHeadersFilter before this
        // filter ran). Re-applied here, synchronously and before the body
        // write below, so the sanitized error response still carries it —
        // matching Node's global security-headers middleware, whose headers
        // are unaffected by an equivalent guard's own res.json() calls.
        response.setHeader(SecurityHeaders.NOSNIFF_NAME, SecurityHeaders.NOSNIFF_VALUE);
        response.setStatus(HttpServletResponse.SC_INTERNAL_SERVER_ERROR);
        response.setContentType("application/json;charset=UTF-8");
        response.getOutputStream().write(BLOCKED_BODY);
    }

    private Optional<PolicyViolation> scanQuietly(byte[] body, ResponsePolicy policy) {
        try {
            JsonNode tree = objectMapper.readTree(body);
            return ResponsePolicyScanner.scan(tree, policy);
        } catch (JacksonException malformed) {
            // Jackson 3 reports parse failures as an unchecked JacksonException
            // (Jackson 2's readTree threw a checked IOException for the same
            // case). Not parseable JSON despite the declared content type means
            // there is nothing structured to scan — let it through rather than
            // failing every non-JSON-shaped response (e.g. a plain string body
            // Spring happened to label as JSON).
            return Optional.empty();
        }
    }

    private boolean isJson(String contentType) {
        return contentType != null
                && contentType.toLowerCase(Locale.ROOT).contains("application/json");
    }
}
