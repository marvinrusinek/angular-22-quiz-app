package com.quizbackend.interview;

import java.util.Locale;
import java.util.regex.Pattern;

/**
 * EXACT port of the Node reference's {@code isAllOfTheAbove}
 * ({@code backend/src/interview/all-of-the-above.ts}), itself a port of
 * Angular's {@code isAllOfTheAbove}. Same normalization chain, same order:
 * strip HTML tags, replace {@code &nbsp;}, trim, lowercase, collapse
 * whitespace, drop trailing punctuation, trim again. Matching is by TEXT
 * only — correctness is never consulted.
 */
public final class AllOfTheAbove {

    private static final Pattern HTML_TAG = Pattern.compile("<[^>]*>");
    private static final Pattern NBSP = Pattern.compile("&nbsp;", Pattern.CASE_INSENSITIVE);
    private static final Pattern WHITESPACE = Pattern.compile("\\s+");
    private static final Pattern TRAILING_PUNCTUATION = Pattern.compile("[.!?]+$");

    private AllOfTheAbove() {
    }

    public static boolean isAllOfTheAbove(String text) {
        String value = text == null ? "" : text;
        String normalized = HTML_TAG.matcher(value).replaceAll(" ");
        normalized = NBSP.matcher(normalized).replaceAll(" ");
        normalized = normalized.trim().toLowerCase(Locale.ROOT);
        normalized = WHITESPACE.matcher(normalized).replaceAll(" ");
        normalized = TRAILING_PUNCTUATION.matcher(normalized).replaceAll("");
        normalized = normalized.trim();
        return normalized.equals("all of the above");
    }
}
