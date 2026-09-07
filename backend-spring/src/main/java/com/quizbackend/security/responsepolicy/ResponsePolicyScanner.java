package com.quizbackend.security.responsepolicy;

import tools.jackson.databind.JsonNode;

import java.util.Map;
import java.util.Optional;

/**
 * Recursively walks a parsed JSON tree and reports the first banned property
 * name found under a given {@link ResponsePolicy}.
 *
 * <p>Ported from {@code response-policy.ts}'s {@code findPolicyViolation()},
 * with one deliberate difference: this scanner runs on a Jackson
 * {@link JsonNode} tree parsed from the response's ALREADY-SERIALIZED JSON
 * bytes (see {@code ResponsePolicyGuardFilter}), not the live Java object
 * graph that produced them. A parsed JSON tree is structurally acyclic &mdash;
 * JSON text has no back-references &mdash; so, unlike the Node original (which
 * guards a {@code WeakSet} against a self-referencing live object), no cycle
 * guard is needed here. Scanning the serialized bytes is also the stronger
 * guarantee: it catches a leak regardless of what Java object, entity, or raw
 * {@code Map} produced it, not just what a DTO's declared shape allows.
 */
public final class ResponsePolicyScanner {

    private ResponsePolicyScanner() {
    }

    public static Optional<PolicyViolation> scan(JsonNode root, ResponsePolicy policy) {
        return walk(root, "", policy);
    }

    private static Optional<PolicyViolation> walk(JsonNode node, String path, ResponsePolicy policy) {
        if (node == null || !(node.isObject() || node.isArray())) {
            return Optional.empty();
        }

        if (node.isArray()) {
            int index = 0;
            for (JsonNode element : node) {
                Optional<PolicyViolation> found = walk(element, path + "[" + index + "]", policy);
                if (found.isPresent()) {
                    return found;
                }
                index++;
            }
            return Optional.empty();
        }

        // Jackson 3 renamed JsonNode#fields() (an Iterator<Map.Entry<...>>) to
        // #properties(), returning a Set<Map.Entry<...>> instead.
        for (Map.Entry<String, JsonNode> entry : node.properties()) {
            String key = entry.getKey();

            if (policy.isBanned(key)) {
                String fullPath = path.isEmpty() ? key : path + "." + key;
                return Optional.of(new PolicyViolation(fullPath, key, policy));
            }

            Optional<PolicyViolation> found = walk(entry.getValue(), path.isEmpty() ? key : path + "." + key, policy);
            if (found.isPresent()) {
                return found;
            }
        }
        return Optional.empty();
    }
}
