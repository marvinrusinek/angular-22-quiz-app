package com.quizbackend.interview;

import com.quizbackend.quiz.QuizRepository;
import com.quizbackend.quiz.entity.QuizEntity;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.when;

/**
 * Parity proof against the Node reference's {@code assessment.preset-builder.ts}:
 * {@code redistributionOrder}'s exact documented anchoring for all three
 * shipped presets, and a full {@code buildPresetAssessment} happy path
 * proving quota-respecting selection end to end.
 */
@ExtendWith(MockitoExtension.class)
class AssessmentPresetBuilderTest {

    @Mock
    private QuizRepository quizRepository;
    @Mock
    private InterviewQuestionRepository questionRepository;

    private AssessmentPresetBuilder builder() {
        return new AssessmentPresetBuilder(quizRepository, questionRepository);
    }

    // ── redistributionOrder — the exact documented examples ─────────────

    @Test
    void juniorRedistributionOrderIsBeginnerThenIntermediate() {
        // quota 9/6/0, allowed beginner+intermediate
        DifficultyQuota quota = new DifficultyQuota(9, 6, 0);
        List<QuizDifficulty> order = AssessmentPresetBuilder.redistributionOrder(
                quota, List.of(QuizDifficulty.BEGINNER, QuizDifficulty.INTERMEDIATE));
        assertThat(order).containsExactly(QuizDifficulty.BEGINNER, QuizDifficulty.INTERMEDIATE);
    }

    @Test
    void midLevelRedistributionOrderIsIntermediateThenBeginnerThenAdvanced() {
        // quota 4/12/4, allowed all three; anchor = intermediate (largest quota)
        DifficultyQuota quota = new DifficultyQuota(4, 12, 4);
        List<QuizDifficulty> order = AssessmentPresetBuilder.redistributionOrder(
                quota, List.of(QuizDifficulty.BEGINNER, QuizDifficulty.INTERMEDIATE, QuizDifficulty.ADVANCED));
        assertThat(order).containsExactly(
                QuizDifficulty.INTERMEDIATE, QuizDifficulty.BEGINNER, QuizDifficulty.ADVANCED);
    }

    @Test
    void seniorRedistributionOrderIsAdvancedThenIntermediateThenBeginner() {
        // quota 2/10/13, allowed all three; anchor = advanced (largest quota)
        DifficultyQuota quota = new DifficultyQuota(2, 10, 13);
        List<QuizDifficulty> order = AssessmentPresetBuilder.redistributionOrder(
                quota, List.of(QuizDifficulty.BEGINNER, QuizDifficulty.INTERMEDIATE, QuizDifficulty.ADVANCED));
        assertThat(order).containsExactly(
                QuizDifficulty.ADVANCED, QuizDifficulty.INTERMEDIATE, QuizDifficulty.BEGINNER);
    }

    // ── presetCapacity / buildPresetAssessment ───────────────────────────

    private QuizEntity quiz(long id, String quizId, String difficulty) {
        return new QuizEntity(id, quizId, quizId, "", "", difficulty, "[]", 0, "active");
    }

    private List<CandidateQuestion> questions(String quizId, int count) {
        List<CandidateQuestion> list = new ArrayList<>();
        for (int i = 0; i < count; i++) {
            list.add(new CandidateQuestion(quizId + ":q:" + i, quizId, i, "Q" + i + "?", "single", "Because.",
                    List.of(new CandidateOption(100 * (i + 1) + 1, 0, "A", true),
                            new CandidateOption(100 * (i + 1) + 2, 1, "B", false)),
                    null));
        }
        return list;
    }

    @Test
    void throwsInsufficientQuestionsWhenThePresetsUsableTopicsCannotCoverIt() {
        InterviewPreset tiny = new InterviewPreset("tiny", "Tiny", 5, 10,
                new DifficultyDistribution(100, 0, 0), List.of("only-topic"));
        when(quizRepository.findByQuizIdAndStatus("only-topic", "active"))
                .thenReturn(Optional.of(quiz(1L, "only-topic", "beginner")));
        when(questionRepository.findByQuizId("only-topic")).thenReturn(questions("only-topic", 2));

        assertThatThrownBy(() -> builder().buildPresetAssessment(tiny, AssessmentRandom.seeded(1)))
                .isInstanceOf(AssessmentBuildException.class)
                .satisfies(ex -> assertThat(((AssessmentBuildException) ex).getCode())
                        .isEqualTo(AssessmentBuildException.Code.INSUFFICIENT_QUESTIONS));
    }

    @Test
    void skipsATopicWithNoDifficultyExactlyLikeTheNodeReference() {
        InterviewPreset preset = new InterviewPreset("p", "P", 2, 10,
                new DifficultyDistribution(100, 0, 0), List.of("no-difficulty-topic"));
        QuizEntity noDifficulty = new QuizEntity(1L, "no-difficulty-topic", "X", "", "", null, "[]", 0, "active");
        when(quizRepository.findByQuizIdAndStatus("no-difficulty-topic", "active")).thenReturn(Optional.of(noDifficulty));

        InterviewPresets.PresetCapacity capacity = builder().presetCapacity(preset);

        assertThat(capacity.usable()).isZero();
    }

    @Test
    void buildsAQuotaRespectingAssessmentFromTwoDifficultyBands() {
        // A 4-question preset, 50/50 beginner/advanced, one topic per band.
        InterviewPreset preset = new InterviewPreset("mix", "Mix", 4, 15,
                new DifficultyDistribution(50, 0, 50), List.of("begin-topic", "adv-topic"));

        lenient().when(quizRepository.findByQuizIdAndStatus("begin-topic", "active"))
                .thenReturn(Optional.of(quiz(1L, "begin-topic", "beginner")));
        lenient().when(quizRepository.findByQuizIdAndStatus("adv-topic", "active"))
                .thenReturn(Optional.of(quiz(2L, "adv-topic", "advanced")));
        lenient().when(questionRepository.findByQuizId("begin-topic")).thenReturn(questions("begin-topic", 5));
        lenient().when(questionRepository.findByQuizId("adv-topic")).thenReturn(questions("adv-topic", 5));

        GeneratedInterviewSnapshot snapshot = builder().buildPresetAssessment(preset, AssessmentRandom.seeded(7));

        assertThat(snapshot.questions()).hasSize(4);
        long fromBeginTopic = snapshot.questions().stream()
                .filter(q -> q.sourceQuizId().equals("begin-topic")).count();
        long fromAdvTopic = snapshot.questions().stream()
                .filter(q -> q.sourceQuizId().equals("adv-topic")).count();
        // quota for 4 @ 50/0/50 is exactly 2/0/2.
        assertThat(fromBeginTopic).isEqualTo(2);
        assertThat(fromAdvTopic).isEqualTo(2);
        assertThat(snapshot.config().difficulty()).isEqualTo("mixed");
        assertThat(snapshot.config().presetId()).isEqualTo("mix");
    }
}
