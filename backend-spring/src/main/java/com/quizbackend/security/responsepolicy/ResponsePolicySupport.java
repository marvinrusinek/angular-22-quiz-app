package com.quizbackend.security.responsepolicy;

/**
 * Key normalization, ported verbatim from {@code response-policy.ts}'s
 * {@code normalizeKey()}.
 *
 * <p>Collapses naming-convention drift so it cannot slip past the guard:
 * {@code is_correct}, {@code isCorrect}, {@code IsCorrect} and
 * {@code is-correct} all normalize to {@code iscorrect}. Comparison against
 * the banned set is then exact, never substring &mdash; so {@code
 * correctOptionIds} stays distinct from {@code correct} and can be allowed
 * independently.
 */
final class ResponsePolicySupport {

    private ResponsePolicySupport() {
    }

    static String normalizeKey(String key) {
        StringBuilder out = new StringBuilder(key.length());
        for (int i = 0; i < key.length(); i++) {
            char c = key.charAt(i);
            if (c == '_' || c == '-' || Character.isWhitespace(c)) {
                continue;
            }
            out.append(Character.toLowerCase(c));
        }
        return out.toString();
    }
}
