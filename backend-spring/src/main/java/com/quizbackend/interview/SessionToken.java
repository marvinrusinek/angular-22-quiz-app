package com.quizbackend.interview;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.regex.Pattern;

/**
 * Port of the Node reference's {@code session.token.ts}. All identity/token
 * values come from a CSPRNG — never from timestamps, quiz ids, or the
 * {@link RandomSource} that shuffles questions. Assessment randomness and
 * security randomness are deliberately separate mechanisms.
 */
public final class SessionToken {

    private static final int TOKEN_BYTES = 32;
    private static final int SESSION_ID_BYTES = 16;
    private static final int ATTEMPT_ID_BYTES = 16;

    /** base64url of 32 bytes -> 43 chars, no padding. */
    private static final Pattern TOKEN_PATTERN = Pattern.compile("^[A-Za-z0-9_-]{43}$");
    private static final Pattern BEARER_PATTERN = Pattern.compile("^Bearer[ ]+(\\S+)$", Pattern.CASE_INSENSITIVE);

    private static final SecureRandom SECURE_RANDOM = new SecureRandom();

    private SessionToken() {
    }

    public record SessionIdentity(String sessionId, String attemptId, String rawToken, String tokenHash) {
    }

    private static String base64Url(byte[] bytes) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    public static String hashToken(String rawToken) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(rawToken.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(hash.length * 2);
            for (byte b : hash) {
                hex.append(String.format("%02x", b));
            }
            return hex.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 must be available", e);
        }
    }

    public static SessionIdentity generateSessionIdentity() {
        byte[] tokenBytes = new byte[TOKEN_BYTES];
        SECURE_RANDOM.nextBytes(tokenBytes);
        String rawToken = base64Url(tokenBytes);

        byte[] sessionIdBytes = new byte[SESSION_ID_BYTES];
        SECURE_RANDOM.nextBytes(sessionIdBytes);
        byte[] attemptIdBytes = new byte[ATTEMPT_ID_BYTES];
        SECURE_RANDOM.nextBytes(attemptIdBytes);

        return new SessionIdentity(
                "is_" + base64Url(sessionIdBytes),
                "ia_" + base64Url(attemptIdBytes),
                rawToken,
                hashToken(rawToken));
    }

    /** Cheap structural check before any database work. */
    public static boolean isWellFormedToken(String rawToken) {
        return rawToken != null && TOKEN_PATTERN.matcher(rawToken).matches();
    }

    /** Constant-time comparison of the two SHA-256 hex digests. */
    public static boolean tokenMatches(String rawToken, String storedHash) {
        if (!isWellFormedToken(rawToken)) {
            return false;
        }
        byte[] presented = hashToken(rawToken).getBytes(StandardCharsets.UTF_8);
        byte[] stored = storedHash.getBytes(StandardCharsets.UTF_8);
        if (presented.length != stored.length) {
            return false;
        }
        return MessageDigest.isEqual(presented, stored);
    }

    /**
     * Extract a bearer token from an Authorization header. A token is
     * accepted ONLY from this header — never a query string, route
     * parameter, cookie, or body.
     */
    public static String extractBearerToken(String header) {
        if (header == null) {
            return null;
        }
        var matcher = BEARER_PATTERN.matcher(header.trim());
        if (!matcher.matches()) {
            return null;
        }
        String token = matcher.group(1);
        return isWellFormedToken(token) ? token : null;
    }
}
