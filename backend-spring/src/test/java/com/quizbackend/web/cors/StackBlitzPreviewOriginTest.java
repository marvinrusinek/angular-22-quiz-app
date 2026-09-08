package com.quizbackend.web.cors;

import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import static com.quizbackend.web.cors.StackBlitzPreviewOrigin.isStackBlitzPreviewOrigin;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * Pure algorithm proof for {@link StackBlitzPreviewOrigin} — ported
 * case-by-case from the Node reference's OWN adversarial test suite
 * ({@code backend/test/stackblitz-preview-origins.test.ts}), read fresh
 * this slice, not re-derived independently. Every allowed/rejected origin
 * below is the SAME string Node's own test asserts on.
 */
class StackBlitzPreviewOriginTest {

    @ParameterizedTest
    @ValueSource(strings = {
            "https://angular22quizapp-uyfq--4200--017acfb7.local-credentialless.webcontainer.io",
            "https://abc123.local-credentialless.webcontainer.io",
            "https://abc123.local-credentialless.webcontainer-api.io",
            "https://abc123--4200.local-credentialless.webcontainer-api.io",
            "https://abc123.w-credentialless-staticblitz.com",
            "https://angular-quiz.stackblitz.io",
            "https://stackblitz.io"
    })
    void allowsLegitimateStackBlitzPreviewFamilies(String origin) {
        assertThat(isStackBlitzPreviewOrigin(origin)).isTrue();
    }

    @ParameterizedTest
    @ValueSource(strings = {
            // http, not https
            "http://abc123.local-credentialless.webcontainer-api.io",
            "http://angular-quiz.stackblitz.io",
            // suffix-confusion: the attacker owns the REAL registrable domain
            "https://webcontainer-api.io.evil.com",
            "https://evil.stackblitz.io.evil.com",
            "https://w-credentialless-staticblitz.com.evil.com",
            // no dot before the suffix — must not match as a subdomain
            "https://evilwebcontainer-api.io",
            "https://evilwebcontainer.io",
            "https://webcontainer.io.evil.com",
            "https://evilstackblitz.io",
            "https://notstackblitz.io",
            // unrelated
            "https://example.com",
            "https://marvinrusinek.github.io.evil.com",
            // not an origin at all
            "https://abc.stackblitz.io/path",
            "https://user:pw@abc.stackblitz.io",
            "not a url",
            ""
    })
    void rejectsEveryAdversarialOrNonOriginCase(String origin) {
        assertThat(isStackBlitzPreviewOrigin(origin)).isFalse();
    }

    @org.junit.jupiter.api.Test
    void rejectsABareHostThatMerelyEndsInTheVendorLetters() {
        // The dot boundary is the whole defence here.
        assertThat(isStackBlitzPreviewOrigin("https://xwebcontainer-api.io")).isFalse();
    }

    @org.junit.jupiter.api.Test
    void rejectsNullSafely() {
        assertThat(isStackBlitzPreviewOrigin(null)).isFalse();
    }

    @org.junit.jupiter.api.Test
    void isCaseInsensitiveOnTheHostnameLikeARealBrowserOrigin() {
        assertThat(isStackBlitzPreviewOrigin("https://ABC123.STACKBLITZ.IO")).isTrue();
    }
}
