package com.quizbackend.interview;

import com.quizbackend.quiz.QuizRepository;
import com.quizbackend.quiz.entity.QuizEntity;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.when;

/**
 * Parity proof against the Node reference's {@code assessment.builder.ts}
 * (the CUSTOM path): {@code allocate()}'s even-split-plus-remainder rule,
 * and {@code validateBuildRequest}'s validation order/error codes.
 */
@ExtendWith(MockitoExtension.class)
class AssessmentBuilderTest {

    @Mock
    private QuizRepository quizRepository;
    @Mock
    private InterviewQuestionRepository questionRepository;

    private AssessmentBuilder builder() {
        return new AssessmentBuilder(quizRepository, questionRepository);
    }

    private QuizEntity quiz(long id, String quizId, String difficulty) {
        return new QuizEntity(id, quizId, quizId, "", "", difficulty, "[]", 0, "active");
    }

    // ── allocate() — pure logic, no mocks needed ────────────────────────

    @Test
    void allocateSplitsEvenlyWithRemainderToTheFirstTopicsInOrder() {
        // 20 across 3 topics -> base 6, remainder 2 -> 7, 7, 6 (the exact
        // documented Node example).
        List<String> topics = List.of("a", "b", "c");
        Map<String, Integer> capacity = Map.of("a", 100, "b", 100, "c", 100);

        Map<String, Integer> allocation = AssessmentBuilder.allocate(topics, capacity, 20);

        assertThat(allocation).containsExactly(Map.entry("a", 7), Map.entry("b", 7), Map.entry("c", 6));
    }

    @Test
    void allocateCapsATargetAtItsTopicsCapacityThenRedistributesTheRemainder() {
        List<String> topics = List.of("a", "b", "c");
        // "a" wants 7 but only has 2; the other 5 must land on b/c.
        Map<String, Integer> capacity = Map.of("a", 2, "b", 100, "c", 100);

        Map<String, Integer> allocation = AssessmentBuilder.allocate(topics, capacity, 20);

        assertThat(allocation.get("a")).isEqualTo(2);
        assertThat(allocation.values().stream().mapToInt(Integer::intValue).sum()).isEqualTo(20);
    }

    // ── validateBuildRequest ─────────────────────────────────────────────

    @Test
    void requiresANonBlankDifficulty() {
        var request = new AssessmentBuilder.BuildRequest("", List.of("rxjs"), 10);
        assertThatThrownBy(() -> builder().validateBuildRequest(request))
                .isInstanceOf(AssessmentBuildException.class)
                .satisfies(ex -> assertThat(((AssessmentBuildException) ex).getCode())
                        .isEqualTo(AssessmentBuildException.Code.INVALID_CONFIG));
    }

    @Test
    void rejectsAnUnknownTopic() {
        when(quizRepository.findByQuizIdAndStatus("ghost", "active")).thenReturn(Optional.empty());

        var request = new AssessmentBuilder.BuildRequest("mixed", List.of("ghost"), 10);
        assertThatThrownBy(() -> builder().validateBuildRequest(request))
                .isInstanceOf(AssessmentBuildException.class)
                .satisfies(ex -> assertThat(((AssessmentBuildException) ex).getCode())
                        .isEqualTo(AssessmentBuildException.Code.UNKNOWN_TOPIC));
    }

    @Test
    void rejectsATopicDifficultyMismatch() {
        when(quizRepository.findByQuizIdAndStatus("rxjs", "active"))
                .thenReturn(Optional.of(quiz(1L, "rxjs", "advanced")));

        var request = new AssessmentBuilder.BuildRequest("beginner", List.of("rxjs"), 10);
        assertThatThrownBy(() -> builder().validateBuildRequest(request))
                .isInstanceOf(AssessmentBuildException.class)
                .satisfies(ex -> assertThat(((AssessmentBuildException) ex).getCode())
                        .isEqualTo(AssessmentBuildException.Code.TOPIC_DIFFICULTY_MISMATCH));
    }

    @Test
    void rejectsAQuestionCountOutsideTheCustomUnion() {
        when(quizRepository.findByQuizIdAndStatus("rxjs", "active"))
                .thenReturn(Optional.of(quiz(1L, "rxjs", "advanced")));

        var request = new AssessmentBuilder.BuildRequest("advanced", List.of("rxjs"), 15);
        assertThatThrownBy(() -> builder().validateBuildRequest(request))
                .isInstanceOf(AssessmentBuildException.class)
                .satisfies(ex -> assertThat(((AssessmentBuildException) ex).getCode())
                        .isEqualTo(AssessmentBuildException.Code.INVALID_CONFIG));
    }

    @Test
    void rejectsInsufficientQuestionsAcrossTheRequestedTopics() {
        when(quizRepository.findByQuizIdAndStatus("rxjs", "active"))
                .thenReturn(Optional.of(quiz(1L, "rxjs", "advanced")));
        when(questionRepository.findByQuizId("rxjs")).thenReturn(List.of());

        var request = new AssessmentBuilder.BuildRequest("advanced", List.of("rxjs"), 10);
        assertThatThrownBy(() -> builder().validateBuildRequest(request))
                .isInstanceOf(AssessmentBuildException.class)
                .satisfies(ex -> assertThat(((AssessmentBuildException) ex).getCode())
                        .isEqualTo(AssessmentBuildException.Code.INSUFFICIENT_QUESTIONS));
    }

    @Test
    void resolvesAValidRequestIntoANormalizedConfig() {
        lenient().when(quizRepository.findByQuizIdAndStatus("rxjs", "active"))
                .thenReturn(Optional.of(quiz(1L, "rxjs", "advanced")));
        CandidateQuestion q = new CandidateQuestion("rxjs:q:0", "rxjs", 0, "Q?", "single", "Because.",
                List.of(new CandidateOption(101, 0, "A", true), new CandidateOption(102, 1, "B", false)), null);
        lenient().when(questionRepository.findByQuizId("rxjs")).thenReturn(List.of(q, q, q, q, q, q, q, q, q, q));

        var request = new AssessmentBuilder.BuildRequest("ADVANCED", List.of(" rxjs "), 10);
        InterviewBuildConfig config = builder().validateBuildRequest(request);

        assertThat(config.difficulty()).isEqualTo("advanced");
        assertThat(config.topicIds()).containsExactly("rxjs");
        assertThat(config.questionCount()).isEqualTo(10);
        assertThat(config.durationSeconds()).isEqualTo(15 * 60);
    }
}
