package com.quizbackend.interview;

/** Port of the Node reference's {@code DifficultyQuota} — how many questions of each difficulty. */
public record DifficultyQuota(int beginner, int intermediate, int advanced) {

    public int get(QuizDifficulty difficulty) {
        return switch (difficulty) {
            case BEGINNER -> beginner;
            case INTERMEDIATE -> intermediate;
            case ADVANCED -> advanced;
        };
    }

    public DifficultyQuota withIncrement(QuizDifficulty difficulty) {
        return switch (difficulty) {
            case BEGINNER -> new DifficultyQuota(beginner + 1, intermediate, advanced);
            case INTERMEDIATE -> new DifficultyQuota(beginner, intermediate + 1, advanced);
            case ADVANCED -> new DifficultyQuota(beginner, intermediate, advanced + 1);
        };
    }

    public int total() {
        return beginner + intermediate + advanced;
    }
}
