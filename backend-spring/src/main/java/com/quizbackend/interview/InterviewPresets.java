package com.quizbackend.interview;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * Line-for-line port of the Node reference's
 * {@code backend/src/interview/interview-presets.ts}: the three shipped
 * presets, {@code calculateDifficultyQuota} (largest-remainder method), and
 * {@code resolvePreset}. Field values (question counts, durations, difficulty
 * weightings, topic ids) are copied exactly from the live Node source, not
 * from any prior summary.
 */
public final class InterviewPresets {

    private InterviewPresets() {
    }

    public static final List<InterviewPreset> ALL = List.of(
            new InterviewPreset(
                    "junior", "Junior Angular Developer", 15, 20,
                    new DifficultyDistribution(60, 40, 0),
                    List.of("typescript", "create-first-app", "templates", "directives", "pipes", "angular-cli",
                            "component-tree", "dependency-injection", "router", "forms")
            ),
            new InterviewPreset(
                    "mid-level", "Mid-Level Angular Developer", 20, 30,
                    new DifficultyDistribution(20, 60, 20),
                    List.of("typescript", "templates",
                            "component-tree", "forms", "router", "http", "testing", "dependency-injection",
                            "material", "change-detection", "rxjs", "signals")
            ),
            new InterviewPreset(
                    "senior", "Senior Angular Developer", 25, 40,
                    new DifficultyDistribution(10, 40, 50),
                    List.of("performance", "testing", "http",
                            "rxjs", "signals", "change-detection", "component-architecture",
                            "dependency-injection-advanced", "design-patterns")
            )
    );

    public static InterviewPreset findById(String id) {
        if (id == null) {
            return null;
        }
        for (InterviewPreset preset : ALL) {
            if (preset.id().equals(id)) {
                return preset;
            }
        }
        return null;
    }

    /**
     * EXACT port of {@code calculateDifficultyQuota} — LARGEST-REMAINDER method.
     * exact = total * pct / 100; base = floor(exact); leftover goes one at a
     * time to the largest fractional remainders. Tie rule: equal remainders
     * resolve to the HIGHER difficulty (advanced first) — implemented below by
     * sorting on remainder descending, then on {@link QuizDifficulty#ordinal()}
     * descending.
     */
    public static DifficultyQuota calculateDifficultyQuota(int questionCount, DifficultyDistribution distribution) {
        if (questionCount < 0) {
            throw new IllegalArgumentException("questionCount must be a non-negative integer");
        }
        if (!distribution.isValid()) {
            throw new IllegalArgumentException("distribution must be nonnegative and total 100");
        }

        record Share(QuizDifficulty difficulty, double share) {
        }

        List<Share> exact = new ArrayList<>();
        for (QuizDifficulty difficulty : QuizDifficulty.values()) {
            exact.add(new Share(difficulty, (questionCount * (double) distribution.get(difficulty)) / 100.0));
        }

        int beginner = (int) Math.floor(exact.get(0).share());
        int intermediate = (int) Math.floor(exact.get(1).share());
        int advanced = (int) Math.floor(exact.get(2).share());
        DifficultyQuota quota = new DifficultyQuota(beginner, intermediate, advanced);

        int leftover = questionCount - quota.total();
        if (leftover <= 0) {
            return quota;
        }

        record Remainder(QuizDifficulty difficulty, double remainder) {
        }

        List<Remainder> byRemainder = new ArrayList<>();
        for (Share share : exact) {
            double remainder = share.share() - Math.floor(share.share());
            if (remainder > 0) {
                byRemainder.add(new Remainder(share.difficulty(), remainder));
            }
        }
        byRemainder.sort(
                Comparator.comparingDouble(Remainder::remainder).reversed()
                        .thenComparing(Comparator.comparingInt((Remainder r) -> r.difficulty().ordinal()).reversed())
        );

        for (Remainder entry : byRemainder) {
            if (leftover == 0) {
                break;
            }
            quota = quota.withIncrement(entry.difficulty());
            leftover -= 1;
        }

        return quota;
    }

    public record PresetCapacity(DifficultyQuota byDifficulty, int usable, int required) {
    }

    public record ResolvedInterviewPreset(
            String presetId,
            String presetName,
            int questionCount,
            int durationSeconds,
            List<String> topicIds,
            DifficultyQuota difficultyQuotas
    ) {
    }

    public static ResolvedInterviewPreset resolvePreset(InterviewPreset preset) {
        int durationSeconds = preset.durationMinutes() * 60;
        if (durationSeconds <= 0) {
            throw new IllegalStateException("preset \"" + preset.id() + "\" resolves to an invalid duration");
        }
        return new ResolvedInterviewPreset(
                preset.id(),
                preset.name(),
                preset.questionCount(),
                durationSeconds,
                List.copyOf(preset.topicIds()),
                calculateDifficultyQuota(preset.questionCount(), preset.difficultyDistribution())
        );
    }
}
