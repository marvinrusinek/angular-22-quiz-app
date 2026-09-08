package com.quizbackend.web.cors;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.List;
import java.util.Locale;

/**
 * Port of the Node reference's {@code isStackBlitzPreviewOrigin}
 * ({@code backend/src/api/preview-origins.ts}). StackBlitz regenerates its
 * preview origin per session, so it cannot live in the exact allow-list the
 * way a deployed host (e.g. gh-pages) does.
 *
 * <p>The check parses the origin as a URI and compares protocol and
 * HOSTNAME only — deliberately NOT a substring/{@code contains()} test,
 * which would accept the exact near-miss attacks this class's tests exist
 * to reject:
 * <ul>
 *   <li>{@code https://webcontainer-api.io.evil.com} — hostname ends with
 *       {@code evil.com}, not the vendor suffix.</li>
 *   <li>{@code https://evilwebcontainer-api.io} — no dot before the
 *       suffix, so it is not a real subdomain.</li>
 * </ul>
 * The leading-dot suffix test below is what makes this a SUBDOMAIN test
 * rather than a string-ends-with test.
 */
public final class StackBlitzPreviewOrigin {

    /** Vendor domains observed serving StackBlitz previews — verbatim from the Node reference. */
    public static final List<String> STACKBLITZ_PREVIEW_DOMAINS = List.of(
            "local-credentialless.webcontainer.io",
            "local-credentialless.webcontainer-api.io",
            "w-credentialless-staticblitz.com",
            "stackblitz.io"
    );

    private StackBlitzPreviewOrigin() {
    }

    /** Is this origin an https StackBlitz preview host? Returns false for anything unparseable. */
    public static boolean isStackBlitzPreviewOrigin(String origin) {
        return isStackBlitzPreviewOrigin(origin, STACKBLITZ_PREVIEW_DOMAINS);
    }

    public static boolean isStackBlitzPreviewOrigin(String origin, List<String> domains) {
        if (origin == null || origin.isEmpty()) {
            return false;
        }

        URI uri;
        try {
            uri = new URI(origin);
        } catch (URISyntaxException notAUri) {
            return false;
        }

        // HTTPS ONLY. A preview served over http is not something to trust.
        if (uri.getScheme() == null || !uri.getScheme().equalsIgnoreCase("https")) {
            return false;
        }

        // An origin carries no user info, path, query, or fragment. Anything
        // that does is not one, and treating it as one would accept
        // `https://evil.com@stackblitz.io`-style confusions.
        if (uri.getRawUserInfo() != null && !uri.getRawUserInfo().isEmpty()) {
            return false;
        }
        String path = uri.getRawPath();
        if (path != null && !path.isEmpty() && !path.equals("/")) {
            return false;
        }
        if (uri.getRawQuery() != null || uri.getRawFragment() != null) {
            return false;
        }

        String hostname = uri.getHost();
        if (hostname == null) {
            return false;
        }
        String lowerHostname = hostname.toLowerCase(Locale.ROOT);

        for (String domain : domains) {
            String suffix = domain.toLowerCase(Locale.ROOT);
            // The leading dot is what makes this a SUBDOMAIN test rather than
            // a string-ends-with test: "evilstackblitz.io" must not match
            // "stackblitz.io".
            if (lowerHostname.equals(suffix) || lowerHostname.endsWith("." + suffix)) {
                return true;
            }
        }
        return false;
    }
}
