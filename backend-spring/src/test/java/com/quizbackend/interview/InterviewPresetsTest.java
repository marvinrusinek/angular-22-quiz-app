package com.quizbackend.interview;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Parity proof against the Node reference's {@code interview-presets.ts}:
 * exact shipped preset values and the largest-remainder quota algorithm's
 * documented results.
 */
class InterviewPresetsTest {

    @Test
    void allThreePresetsAreShippedWithTheDocumentedFieldValues() {
        assertThat(InterviewPresets.ALL).hasSize(3);

        InterviewPreset junior = InterviewPresets.findById("junior");
        assertThat(junior.questionCount()).isEqualTo(15);
        assertThat(junior.durationMinutes()).isEqualTo(20);
        assertThat(junior.difficultyDistribution()).isEqualTo(new DifficultyDistribution(60, 40, 0));
        assertThat(junior.topicIds()).hasSize(10);

        InterviewPreset mid = InterviewPresets.findById("mid-level");
        assertThat(mid.questionCount()).isEqualTo(20);
        assertThat(mid.durationMinutes()).isEqualTo(30);
        assertThat(mid.difficultyDistribution()).isEqualTo(new DifficultyDistribution(20, 60, 20));

        InterviewPreset senior = InterviewPresets.findById("senior");
        assertThat(senior.questionCount()).isEqualTo(25);
        assertThat(senior.durationMinutes()).isEqualTo(40);
        assertThat(senior.difficultyDistribution()).isEqualTo(new DifficultyDistribution(10, 40, 50));
    }

    @Test
    void findByIdReturnsNullForAnUnknownId() {
        assertThat(InterviewPresets.findById("nonexistent")).isNull();
        assertThat(InterviewPresets.findById(null)).isNull();
    }

    @Test
    void juniorQuotaIsExactWithNoRemainder() {
        DifficultyQuota quota = InterviewPresets.calculateDifficultyQuota(15, new DifficultyDistribution(60, 40, 0));
        assertThat(quota).isEqualTo(new DifficultyQuota(9, 6, 0));
    }

    @Test
    void midLevelQuotaIsExactWithNoRemainder() {
        DifficultyQuota quota = InterviewPresets.calculateDifficultyQuota(20, new DifficultyDistribution(20, 60, 20));
        assertThat(quota).isEqualTo(new DifficultyQuota(4, 12, 4));
    }

    @Test
    void seniorQuotaResolvesATieTowardTheHigherDifficulty() {
        // floors 2/10/12 (10% of 25 = 2.5, 40% = 10, 50% = 12.5); the single
        // leftover is a .5 tie between beginner and advanced -> advanced wins.
        DifficultyQuota quota = InterviewPresets.calculateDifficultyQuota(25, new DifficultyDistribution(10, 40, 50));
        assertThat(quota).isEqualTo(new DifficultyQuota(2, 10, 13));
    }

    @Test
    void aZeroWeightedDifficultyNeverReceivesAQuestion() {
        DifficultyQuota quota = InterviewPresets.calculateDifficultyQuota(15, new DifficultyDistribution(60, 40, 0));
        assertThat(quota.advanced()).isZero();
    }

    @Test
    void rejectsANegativeQuestionCount() {
        assertThatThrownBy(() -> InterviewPresets.calculateDifficultyQuota(-1, new DifficultyDistribution(100, 0, 0)))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void rejectsADistributionThatDoesNotTotal100() {
        assertThatThrownBy(() -> InterviewPresets.calculateDifficultyQuota(10, new DifficultyDistribution(50, 40, 0)))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void resolvePresetConvertsMinutesToSecondsAndAttachesTheQuota() {
        InterviewPresets.ResolvedInterviewPreset resolved = InterviewPresets.resolvePreset(InterviewPresets.findById("junior"));
        assertThat(resolved.durationSeconds()).isEqualTo(20 * 60);
        assertThat(resolved.difficultyQuotas()).isEqualTo(new DifficultyQuota(9, 6, 0));
    }
}
