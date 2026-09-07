package com.quizbackend.interview;

/** Port of the Node reference's {@code DifficultyDistribution}. Percentages, must total 100. */
public record DifficultyDistribution(int beginner, int intermediate, int advanced) {

    public int get(QuizDifficulty difficulty) {
        return switch (difficulty) {
            case BEGINNER -> beginner;
            case INTERMEDIATE -> intermediate;
            case ADVANCED -> advanced;
        };
    }

    public boolean isValid() {
        if (beginner < 0 || intermediate < 0 || advanced < 0) {
            return false;
        }
        return beginner + intermediate + advanced == 100;
    }
}
