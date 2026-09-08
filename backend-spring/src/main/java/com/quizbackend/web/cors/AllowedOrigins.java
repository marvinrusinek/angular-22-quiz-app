package com.quizbackend.web.cors;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * The exact-match origin allow-list — port of the Node reference's {@code
 * parseAllowedOrigins} ({@code backend/src/config.ts}), sourced from the
 * SAME environment variable name ({@code ALLOWED_ORIGINS}, comma-separated)
 * for operational consistency between the two backends.
 *
 * <p>Every entry is validated the way Node always validates one (not only
 * in production): must parse as a URL, must be exactly {@code
 * scheme://host[:port]} with no path/query/fragment, and a literal {@code
 * "*"} is rejected outright — a wildcard here is always a mistake and would
 * defeat the point of restricting the API at all.
 *
 * <p>DELIBERATE ADAPTATION from Node: Node falls back to a fixed dev
 * default ({@code http://localhost:4200}, {@code http://127.0.0.1:4200})
 * when unset and not in production, and only REQUIRES a non-empty list in
 * production. This migration has no established "production" flag (Slice 2
 * chose to always require {@code SPRING_DATASOURCE_URL} rather than
 * introduce one, and Slice 6B applied the same precedent to {@code
 * TOPIC_QUIZ_RECEIPT_SECRET}). Consistent with that precedent, an unset
 * value here resolves to an EMPTY allow-list (no extra static origins
 * beyond the StackBlitz preview matcher) rather than a dev default that
 * would apply identically in every environment, including a misconfigured
 * production deployment. This is a SAFE default (fewer origins permitted,
 * never more) — never a permissive fallback — and is documented here
 * rather than chosen silently. Node's own https-required-in-production
 * check is likewise not replicated (no production flag to gate it on);
 * the structural checks (valid URL, no path/query/fragment, no wildcard)
 * are applied unconditionally instead, matching what Node itself always
 * enforces regardless of environment.
 */
@Component
public class AllowedOrigins {

    private final Set<String> origins;

    public AllowedOrigins(@Value("${cors.allowed-origins:}") String rawValue) {
        this.origins = parse(rawValue);
    }

    private static Set<String> parse(String rawValue) {
        List<String> entries = new ArrayList<>();
        for (String candidate : rawValue.split(",")) {
            String trimmed = candidate.trim();
            if (!trimmed.isEmpty()) {
                entries.add(trimmed);
            }
        }

        if (entries.contains("*")) {
            throw new IllegalStateException("ALLOWED_ORIGINS must not contain \"*\" — list exact origins");
        }

        for (String origin : entries) {
            validateStructure(origin);
        }

        return entries.stream().collect(Collectors.toUnmodifiableSet());
    }

    /** An Origin header is scheme + host + port only; a path/query/fragment would never match one. */
    private static void validateStructure(String origin) {
        URI uri;
        try {
            uri = new URI(origin);
        } catch (URISyntaxException notAUri) {
            throw new IllegalStateException("ALLOWED_ORIGINS entry is not a valid URL: \"" + origin + "\"");
        }
        String path = uri.getRawPath();
        boolean hasPath = path != null && !path.isEmpty() && !path.equals("/");
        if (hasPath || uri.getRawQuery() != null || uri.getRawFragment() != null) {
            throw new IllegalStateException(
                    "ALLOWED_ORIGINS entry must be scheme://host[:port] with no path: \"" + origin + "\"");
        }
        if (uri.getScheme() == null || uri.getHost() == null) {
            throw new IllegalStateException("ALLOWED_ORIGINS entry is not a valid URL: \"" + origin + "\"");
        }
    }

    /** Exact string match only — never a pattern. */
    public boolean contains(String origin) {
        return origins.contains(origin);
    }

    public Set<String> asSet() {
        return origins;
    }
}
