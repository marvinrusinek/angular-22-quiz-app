package com.quizbackend.security.responsepolicy;

/**
 * A single detected violation. {@code value} is deliberately never captured
 * anywhere in this package &mdash; only the property NAME and its dotted path,
 * matching the Node reference's own discipline (its log line names the route,
 * policy and key only, never the payload).
 *
 * @param path   dotted/bracketed path to the offending property, e.g. {@code questions[0].options[1].isCorrect}
 * @param key    the offending property name, exactly as it appeared in the JSON
 * @param policy the policy that was violated
 */
public record PolicyViolation(String path, String key, ResponsePolicy policy) {
}
