package com.quizbackend.quiz;

import com.quizbackend.quiz.dto.QuizMetadataDto;
import com.quizbackend.web.error.ApiException;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import java.util.List;

import static org.hamcrest.Matchers.nullValue;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * Controller/API parity proof against the Node reference's
 * {@code GET /quizzes} and {@code GET /quizzes/:quizId}
 * ({@code backend/src/routes/quizzes.route.ts}).
 *
 * <p>Runs against the REAL Spring context with the REAL response-policy
 * guard filter registered ({@code @AutoConfigureMockMvc} wires it into the
 * MockMvc chain, exactly like {@code ResponsePolicyGuardFilterTest}) —
 * {@link QuizService} is mocked so this class needs no database, but the
 * actual serialized JSON is still scanned by the real guard, proving the
 * controller's {@code ResponsePolicyContext.set(request, PUBLIC_METADATA)}
 * call is genuinely wired, not just present in source.
 */
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
class QuizControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @MockitoBean
    private QuizService quizService;

    private static final QuizMetadataDto RXJS = new QuizMetadataDto(
            "rxjs", "RxJS Fundamentals", "Observables, operators and subscriptions.",
            "rxjs.svg", "intermediate", List.of("RxJS ships with over 100 operators."), 9);

    private static final QuizMetadataDto SIGNALS = new QuizMetadataDto(
            "signals", "Angular Signals", "Fine-grained reactivity.",
            "signals.svg", "intermediate", List.of(), 11);

    @Test
    void listReturnsEveryQuizInRepositoryOrderWithTheExactFieldSet() throws Exception {
        when(quizService.listQuizMetadata()).thenReturn(List.of(SIGNALS, RXJS));

        mockMvc.perform(get("/api/quizzes"))
                .andExpect(status().isOk())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
                .andExpect(jsonPath("$.quizzes.length()").value(2))
                .andExpect(jsonPath("$.quizzes[0].quizId").value("signals"))
                .andExpect(jsonPath("$.quizzes[0].questionCount").value(11))
                .andExpect(jsonPath("$.quizzes[1].quizId").value("rxjs"))
                // Exactly the QuizMetadataDto field set — nothing else.
                .andExpect(jsonPath("$.quizzes[0].length()").value(7))
                // Never questions/options/explanation/any identifier field.
                .andExpect(jsonPath("$.quizzes[0].questions").doesNotExist())
                .andExpect(jsonPath("$.quizzes[0].options").doesNotExist())
                .andExpect(jsonPath("$.quizzes[0].explanation").doesNotExist())
                .andExpect(jsonPath("$.quizzes[0].id").doesNotExist())
                .andExpect(jsonPath("$.quizzes[0].displayOrder").doesNotExist())
                .andExpect(jsonPath("$.quizzes[0].status").doesNotExist());
    }

    @Test
    void getOneReturnsBareMetadataObjectForAKnownQuiz() throws Exception {
        when(quizService.getQuizMetadata("rxjs")).thenReturn(RXJS);

        mockMvc.perform(get("/api/quizzes/rxjs"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.quizId").value("rxjs"))
                .andExpect(jsonPath("$.milestone").value("RxJS Fundamentals"))
                .andExpect(jsonPath("$.difficulty").value("intermediate"))
                .andExpect(jsonPath("$.facts[0]").value("RxJS ships with over 100 operators."))
                .andExpect(jsonPath("$.questionCount").value(9))
                // A bare object, NOT wrapped in { quizzes: [...] } like the list route.
                .andExpect(jsonPath("$.quizzes").doesNotExist());
    }

    @Test
    void getOneReturns404WithTheApiErrorEnvelopeForAnUnknownQuiz() throws Exception {
        when(quizService.getQuizMetadata("nonexistent")).thenThrow(ApiException.notFound("Quiz not found"));

        mockMvc.perform(get("/api/quizzes/nonexistent"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("NOT_FOUND"))
                .andExpect(jsonPath("$.error.message").value("Quiz not found"));
    }

    @Test
    void aQuizWithNullDifficultyOmitsNothingButSerializesNull() throws Exception {
        QuizMetadataDto noDifficulty = new QuizMetadataDto(
                "typescript", "TypeScript", "", "", null, List.of(), 5);
        when(quizService.getQuizMetadata("typescript")).thenReturn(noDifficulty);

        mockMvc.perform(get("/api/quizzes/typescript"))
                .andExpect(status().isOk())
                // The key is present with a JSON null, not omitted — matching
                // the Node reference, which likewise always emits `difficulty`.
                .andExpect(jsonPath("$.difficulty").value(nullValue()));
    }
}
