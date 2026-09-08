package com.quizbackend.web.cors;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.stereotype.Component;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;

import java.util.List;

import static com.quizbackend.web.cors.StackBlitzPreviewOrigin.isStackBlitzPreviewOrigin;

/**
 * Port of the Node reference's {@code buildCorsOptions} ({@code
 * backend/src/app.ts}): CORS against an exact allow-list, plus the
 * StackBlitz preview matcher, expressed as a dynamic {@link
 * CorsConfigurationSource} rather than a static configuration — Spring's
 * built-in {@link org.springframework.web.filter.CorsFilter}/{@code
 * DefaultCorsProcessor} then applies the SAME methods/headers/credentials/
 * max-age Node applies, and echoes back the SPECIFIC validated origin
 * (never a wildcard), exactly like Node's {@code cors} middleware does for
 * a dynamic per-request {@code origin} callback.
 *
 * <p>{@code credentials} stays FALSE by design: the session token and
 * receipts travel in headers, never a cookie, so the browser never needs
 * to send credentials cross-origin — the same reasoning Node's own
 * comment gives.
 *
 * <p>A disallowed origin is not rejected here: {@link
 * #getCorsConfiguration} returns {@code null}, and Spring's own {@code
 * DefaultCorsProcessor} then lets a NON-preflight request proceed without
 * CORS response headers (matching Node's "the response simply carries no
 * CORS headers, which the browser enforces" posture exactly) while
 * rejecting only the PREFLIGHT itself with 403 — a Spring-builtin
 * difference from Node's own 204-without-header preflight response,
 * documented in the Slice 6C report as a non-weakening divergence (it is
 * STRICTER for an already-disallowed prober, and never affects a
 * legitimate, allow-listed caller).
 */
@Component
public class ApiCorsConfigurationSource implements CorsConfigurationSource {

    /**
     * Named individually rather than widened to a wildcard: these are the
     * only custom headers the API accepts. Advertised on EVERY preflight
     * regardless of what was actually requested — a static list, not a
     * reflection of {@code Access-Control-Request-Headers} — exactly
     * matching Node's own static {@code allowedHeaders} array.
     */
    private static final List<String> ALLOWED_HEADERS = List.of(
            "Content-Type", "Authorization", "X-Attempt-Receipt", "X-Question-Receipt");

    private static final List<String> ALLOWED_METHODS = List.of("GET", "POST", "PUT", "OPTIONS");

    /** 600 seconds, matching Node's {@code maxAge: 600}. */
    private static final long MAX_AGE_SECONDS = 600;

    private final AllowedOrigins allowedOrigins;

    public ApiCorsConfigurationSource(AllowedOrigins allowedOrigins) {
        this.allowedOrigins = allowedOrigins;
    }

    @Override
    public CorsConfiguration getCorsConfiguration(HttpServletRequest request) {
        String origin = request.getHeader("Origin");

        // No Origin header: same-origin, curl, or a server-side caller.
        // Nothing to grant, nothing to block — CORS simply does not apply.
        // (Spring's own CorsProcessor already treats a request with no
        // Origin header as "not a CORS request" and never consults this
        // source at all; this early return only matters if invoked
        // directly, e.g. from a test.)
        if (origin == null) {
            return null;
        }

        boolean allowed = allowedOrigins.contains(origin) || isStackBlitzPreviewOrigin(origin);
        if (!allowed) {
            return null;
        }

        CorsConfiguration config = new CorsConfiguration();
        // The SPECIFIC validated origin, never "*" — matches Node echoing
        // back exactly the origin it approved.
        config.setAllowedOrigins(List.of(origin));
        config.setAllowedMethods(ALLOWED_METHODS);
        config.setAllowedHeaders(ALLOWED_HEADERS);
        config.setAllowCredentials(false);
        config.setMaxAge(MAX_AGE_SECONDS);
        return config;
    }
}
