package com.quizbackend.web;

import java.util.List;
import java.util.Map;

/**
 * The exact header set applied to EVERY response &mdash; shared between
 * {@link SecurityHeadersFilter} (the normal-path writer) and
 * {@code ResponsePolicyGuardFilter} (which must re-apply the same set after
 * {@code response.reset()} wipes it on a violation).
 *
 * <p>Slice 6 parity correction: re-read against the Node reference's {@code
 * backend/src/shared/security-headers.ts} fresh, which sets FIVE headers on
 * every response, not just {@code X-Content-Type-Options} (the Slice 2
 * correction had deliberately scoped this filter to one header and deferred
 * the rest &mdash; see that slice's Risks/Follow-ups). All five are now
 * ported, verbatim name/value, matching Node exactly.
 */
public final class SecurityHeaders {

    public static final String NOSNIFF_NAME = "X-Content-Type-Options";
    public static final String NOSNIFF_VALUE = "nosniff";

    /**
     * The complete Node-parity header set, in the same order Node's {@code
     * securityHeaders} middleware sets them. A {@link Map} would lose that
     * order and cannot hold the (harmlessly) duplicate-looking pair shape as
     * cleanly as an ordered list of entries.
     */
    public static final List<Map.Entry<String, String>> ALL = List.of(
            Map.entry(NOSNIFF_NAME, NOSNIFF_VALUE),
            Map.entry("Referrer-Policy", "no-referrer"),
            Map.entry("Cross-Origin-Resource-Policy", "same-site"),
            Map.entry("Cache-Control", "no-store"),
            Map.entry("Pragma", "no-cache"));

    private SecurityHeaders() {
    }
}
