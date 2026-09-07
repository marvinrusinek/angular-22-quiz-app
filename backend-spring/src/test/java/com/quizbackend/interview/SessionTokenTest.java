package com.quizbackend.interview;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class SessionTokenTest {

    @Test
    void generatedIdentityHasTheExpectedShapeAndPrefixes() {
        SessionToken.SessionIdentity identity = SessionToken.generateSessionIdentity();

        assertThat(identity.sessionId()).startsWith("is_");
        assertThat(identity.attemptId()).startsWith("ia_");
        assertThat(SessionToken.isWellFormedToken(identity.rawToken())).isTrue();
        assertThat(identity.tokenHash()).matches("^[0-9a-f]{64}$");
        // The hash actually verifies the raw token it was derived from.
        assertThat(SessionToken.tokenMatches(identity.rawToken(), identity.tokenHash())).isTrue();
    }

    @Test
    void twoGeneratedIdentitiesAreNeverEqual() {
        SessionToken.SessionIdentity a = SessionToken.generateSessionIdentity();
        SessionToken.SessionIdentity b = SessionToken.generateSessionIdentity();
        assertThat(a.rawToken()).isNotEqualTo(b.rawToken());
        assertThat(a.sessionId()).isNotEqualTo(b.sessionId());
    }

    @Test
    void tokenMatchesRejectsAWrongToken() {
        SessionToken.SessionIdentity identity = SessionToken.generateSessionIdentity();
        SessionToken.SessionIdentity other = SessionToken.generateSessionIdentity();
        assertThat(SessionToken.tokenMatches(other.rawToken(), identity.tokenHash())).isFalse();
    }

    @Test
    void tokenMatchesRejectsAMalformedToken() {
        assertThat(SessionToken.tokenMatches("not-a-real-token", "irrelevant-hash")).isFalse();
    }

    @Test
    void extractBearerTokenAcceptsTheSchemeCaseInsensitively() {
        SessionToken.SessionIdentity identity = SessionToken.generateSessionIdentity();
        assertThat(SessionToken.extractBearerToken("Bearer " + identity.rawToken())).isEqualTo(identity.rawToken());
        assertThat(SessionToken.extractBearerToken("bearer " + identity.rawToken())).isEqualTo(identity.rawToken());
        assertThat(SessionToken.extractBearerToken("BEARER " + identity.rawToken())).isEqualTo(identity.rawToken());
    }

    @Test
    void extractBearerTokenRejectsAMissingOrMalformedHeader() {
        assertThat(SessionToken.extractBearerToken(null)).isNull();
        assertThat(SessionToken.extractBearerToken("")).isNull();
        assertThat(SessionToken.extractBearerToken("Basic dXNlcjpwYXNz")).isNull();
        assertThat(SessionToken.extractBearerToken("Bearer not-well-formed")).isNull();
    }
}
