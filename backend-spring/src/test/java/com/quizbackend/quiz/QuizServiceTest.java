package com.quizbackend.quiz;

import com.quizbackend.quiz.dto.QuizMetadataDto;
import com.quizbackend.quiz.entity.QuizEntity;
import com.quizbackend.web.error.ApiException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;

/**
 * Pure unit tests (no Spring context, no database) for {@link QuizService}'s
 * mapping logic — parity checks against the Node reference's
 * {@code toQuizMetadataDto} / {@code parseFacts} ({@code quiz.dto.ts},
 * {@code quiz.db-source.ts}).
 */
@ExtendWith(MockitoExtension.class)
class QuizServiceTest {

    private final ObjectMapper objectMapper = JsonMapper.builder().build();

    @Mock
    private QuizRepository quizRepository;

    private QuizEntity quiz(long id, String quizId, String factsJson, int displayOrder) {
        return new QuizEntity(id, quizId, "Milestone " + quizId, "Summary", "image.svg",
                "intermediate", factsJson, displayOrder, "active");
    }

    private QuizService service() {
        return new QuizService(quizRepository, objectMapper);
    }

    @Test
    void mapsAllFieldsFromTheEntityFieldByField() {
        when(quizRepository.findByStatusOrderByDisplayOrder("active"))
                .thenReturn(List.of(quiz(1L, "rxjs", "[\"Fact one\"]", 0)));
        when(quizRepository.countQuestionsByQuizPks(List.of(1L)))
                .thenReturn(List.of(countRow(1L, 9L)));

        List<QuizMetadataDto> result = service().listQuizMetadata();

        assertThat(result).hasSize(1);
        QuizMetadataDto dto = result.get(0);
        assertThat(dto.quizId()).isEqualTo("rxjs");
        assertThat(dto.milestone()).isEqualTo("Milestone rxjs");
        assertThat(dto.summary()).isEqualTo("Summary");
        assertThat(dto.image()).isEqualTo("image.svg");
        assertThat(dto.difficulty()).isEqualTo("intermediate");
        assertThat(dto.facts()).containsExactly("Fact one");
        assertThat(dto.questionCount()).isEqualTo(9L);
    }

    @Test
    void parsesFactsJsonAsAnArrayOfStrings() {
        when(quizRepository.findByStatusOrderByDisplayOrder("active"))
                .thenReturn(List.of(quiz(1L, "rxjs", "[\"a\",\"b\",\"c\"]", 0)));
        when(quizRepository.countQuestionsByQuizPks(any())).thenReturn(List.of());

        assertThat(service().listQuizMetadata().get(0).facts()).containsExactly("a", "b", "c");
    }

    @Test
    void nullFactsJsonYieldsAnEmptyList() {
        when(quizRepository.findByStatusOrderByDisplayOrder("active"))
                .thenReturn(List.of(quiz(1L, "rxjs", null, 0)));
        when(quizRepository.countQuestionsByQuizPks(any())).thenReturn(List.of());

        assertThat(service().listQuizMetadata().get(0).facts()).isEmpty();
    }

    @Test
    void malformedFactsJsonYieldsAnEmptyListRatherThanFailing() {
        // Parity with the Node reference's parseFacts(): display-only trivia
        // must never break metadata delivery.
        when(quizRepository.findByStatusOrderByDisplayOrder("active"))
                .thenReturn(List.of(quiz(1L, "rxjs", "{not valid json", 0)));
        when(quizRepository.countQuestionsByQuizPks(any())).thenReturn(List.of());

        assertThat(service().listQuizMetadata().get(0).facts()).isEmpty();
    }

    @Test
    void aFactsArrayContainingNonStringsKeepsOnlyTheStrings() {
        when(quizRepository.findByStatusOrderByDisplayOrder("active"))
                .thenReturn(List.of(quiz(1L, "rxjs", "[\"a\", 42, null, \"b\"]", 0)));
        when(quizRepository.countQuestionsByQuizPks(any())).thenReturn(List.of());

        assertThat(service().listQuizMetadata().get(0).facts()).containsExactly("a", "b");
    }

    @Test
    void aQuizWithNoQuestionRowsGetsZeroRatherThanAMissingEntry() {
        when(quizRepository.findByStatusOrderByDisplayOrder("active"))
                .thenReturn(List.of(quiz(1L, "rxjs", "[]", 0)));
        // Deliberately returns no rows at all for quiz pk 1 — the projection
        // query only returns a row per quiz that HAS questions.
        when(quizRepository.countQuestionsByQuizPks(List.of(1L))).thenReturn(List.of());

        assertThat(service().listQuizMetadata().get(0).questionCount()).isZero();
    }

    @Test
    void preservesRepositoryOrderAcrossMultipleQuizzes() {
        // The repository query itself is ORDER BY display_order — this test
        // proves the service does not silently reorder what it returns.
        when(quizRepository.findByStatusOrderByDisplayOrder("active"))
                .thenReturn(List.of(
                        quiz(1L, "signals", "[]", 0),
                        quiz(2L, "rxjs", "[]", 1),
                        quiz(3L, "di", "[]", 2)));
        when(quizRepository.countQuestionsByQuizPks(any())).thenReturn(List.of());

        List<QuizMetadataDto> result = service().listQuizMetadata();

        assertThat(result).extracting(QuizMetadataDto::quizId)
                .containsExactly("signals", "rxjs", "di");
    }

    @Test
    void getQuizMetadataReturnsTheSingleQuizWithItsCount() {
        when(quizRepository.findByQuizIdAndStatus("signals", "active"))
                .thenReturn(java.util.Optional.of(quiz(5L, "signals", "[]", 3)));
        when(quizRepository.countQuestionsByQuizPks(List.of(5L)))
                .thenReturn(List.of(countRow(5L, 11L)));

        QuizMetadataDto dto = service().getQuizMetadata("signals");

        assertThat(dto.quizId()).isEqualTo("signals");
        assertThat(dto.questionCount()).isEqualTo(11L);
    }

    @Test
    void getQuizMetadataThrowsNotFoundForAnUnknownOrRetiredQuiz() {
        when(quizRepository.findByQuizIdAndStatus("nonexistent", "active"))
                .thenReturn(java.util.Optional.empty());

        assertThatThrownBy(() -> service().getQuizMetadata("nonexistent"))
                .isInstanceOf(ApiException.class)
                .satisfies(ex -> assertThat(((ApiException) ex).getCode()).isEqualTo("NOT_FOUND"));
    }

    private QuizRepository.QuestionCountProjection countRow(long quizPk, long count) {
        return new QuizRepository.QuestionCountProjection() {
            @Override
            public Long getQuizPk() {
                return quizPk;
            }

            @Override
            public Long getQuestionCount() {
                return count;
            }
        };
    }
}
