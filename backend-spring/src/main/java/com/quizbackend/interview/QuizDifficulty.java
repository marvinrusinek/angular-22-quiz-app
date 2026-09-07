package com.quizbackend.interview;

/**
 * Port of the Node reference's {@code QuizDifficulty} + {@code DIFFICULTY_ORDER}
 * ({@code backend/src/interview/interview-presets.ts}). Declaration order IS
 * {@code DIFFICULTY_ORDER} (least to most difficult) — {@link #ordinal()} is
 * used directly wherever Node uses {@code DIFFICULTY_ORDER.indexOf(...)}.
 */
public enum QuizDifficulty {
    BEGINNER,
    INTERMEDIATE,
    ADVANCED;

    /** The exact lowercase string this difficulty is stored as (quizzes.difficulty). */
    public String wireValue() {
        return name().toLowerCase(java.util.Locale.ROOT);
    }

    public static QuizDifficulty fromWireValue(String value) {
        for (QuizDifficulty difficulty : values()) {
            if (difficulty.wireValue().equals(value)) {
                return difficulty;
            }
        }
        return null;
    }
}
