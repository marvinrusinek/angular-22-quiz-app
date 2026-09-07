package com.quizbackend.quiz.topicquiz;

import com.quizbackend.interview.InterviewQuestionRepository;
import com.quizbackend.interview.InterviewSessionRepository;
import com.quizbackend.quiz.QuizRepository;
import com.quizbackend.quiz.QuizResourceRepository;
import com.quizbackend.quiz.dto.AttemptIssuedDto;
import com.quizbackend.quiz.dto.QuestionStartedDto;
import com.quizbackend.quiz.dto.QuizResourceDto;
import com.quizbackend.quiz.dto.QuizResourcesBody;
import com.quizbackend.quiz.dto.TopicQuizOptionDto;
import com.quizbackend.quiz.dto.TopicQuizQuestionDto;
import com.quizbackend.quiz.dto.TopicQuizQuestionsDto;
import com.quizbackend.quiz.ratelimit.RateLimitedException;
import com.quizbackend.quiz.receipt.AttemptReceiptException;
import com.quizbackend.quiz.receipt.QuestionReceiptException;
import com.quizbackend.web.error.ApiException;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import java.util.List;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * Controller/API + response-policy security proof for the five Topic Quiz
 * routes, against the REAL Spring context with the REAL response-policy
 * guard and security-header filters registered — same pattern as {@code
 * InterviewSessionControllerTest}. {@link TopicQuizService} is mocked so
 * this class needs no database, but the actual serialized JSON still
 * passes through the real guard, proving {@code QUIZ_QUESTIONS}/{@code
 * ATTEMPT_ISSUED}/{@code ANSWER_REVEAL} are genuinely wired and genuinely
 * distinct from each other and from {@code ACTIVE_ASSESSMENT}.
 */
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
class TopicQuizControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @MockitoBean
    private TopicQuizService service;

    // Beans TopicQuizService's real constructor chain would otherwise need
    // to build a working application context under the "test" profile.
    @MockitoBean
    private QuizRepository quizRepository;
    @MockitoBean
    private QuizResourceRepository quizResourceRepository;
    @MockitoBean
    private InterviewQuestionRepository interviewQuestionRepository;
    @MockitoBean
    private InterviewSessionRepository interviewSessionRepository;

    private TopicQuizQuestionsDto sampleQuestionsDto() {
        TopicQuizOptionDto correct = new TopicQuizOptionDto("A multicast observable");
        TopicQuizOptionDto wrong = new TopicQuizOptionDto("A pipe");
        TopicQuizQuestionDto question = new TopicQuizQuestionDto(
                "Which answer is correct?", "single", "beginner", 1, List.of(correct, wrong), null);
        return new TopicQuizQuestionsDto("rxjs", List.of(question));
    }

    // ── GET .../questions — QUIZ_QUESTIONS ───────────────────────────────

    @Test
    void questionsReturns200AndCarriesNoIdentifiersCorrectnessOrExplanation() throws Exception {
        when(service.getQuestions("rxjs")).thenReturn(sampleQuestionsDto());

        mockMvc.perform(get("/api/quizzes/rxjs/questions"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.quizId").value("rxjs"))
                .andExpect(jsonPath("$.questions[0].questionText").value("Which answer is correct?"))
                .andExpect(jsonPath("$.questions[0].correctCount").value(1))
                .andExpect(jsonPath("$.questions[0].options[0].text").value("A multicast observable"))
                // QUIZ_QUESTIONS is the strictest policy: no ids, no correctness, no explanation.
                .andExpect(jsonPath("$.questions[0].questionId").doesNotExist())
                .andExpect(jsonPath("$.questions[0].options[0].optionId").doesNotExist())
                .andExpect(jsonPath("$.questions[0].options[0].isCorrect").doesNotExist())
                .andExpect(jsonPath("$.questions[0].explanation").doesNotExist())
                .andExpect(header().string("X-Content-Type-Options", "nosniff"))
                .andExpect(header().string("Cache-Control", "no-store"));
    }

    @Test
    void questionsOfAnUnknownQuizReturns404() throws Exception {
        when(service.getQuestions("nope")).thenThrow(ApiException.notFound("Quiz not found"));

        mockMvc.perform(get("/api/quizzes/nope/questions"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("NOT_FOUND"));
    }

    // ── GET .../resources — PUBLIC_METADATA ──────────────────────────────

    @Test
    void resourcesReturns200WithTheResourceList() throws Exception {
        when(service.getResources("rxjs")).thenReturn(
                new QuizResourcesBody("rxjs", List.of(new QuizResourceDto("RxJS docs", "https://rxjs.dev", "RxJS"))));

        mockMvc.perform(get("/api/quizzes/rxjs/resources"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.resources[0].title").value("RxJS docs"))
                .andExpect(header().string("X-Content-Type-Options", "nosniff"));
    }

    @Test
    void resourcesOfAnUnknownQuizReturns404NotAnEmptyList() throws Exception {
        when(service.getResources("nope")).thenThrow(ApiException.notFound("Quiz not found"));
        mockMvc.perform(get("/api/quizzes/nope/resources")).andExpect(status().isNotFound());
    }

    // ── POST .../attempts — ATTEMPT_ISSUED ───────────────────────────────

    @Test
    void attemptsReturns201WithAReceiptAndNoAnswerKeyOrSecret() throws Exception {
        when(service.issueAttempt("rxjs")).thenReturn(
                new AttemptIssuedDto("rxjs", 120, 1_700_000_000_000L, 1_700_000_120_000L, "receipt.sig"));

        mockMvc.perform(post("/api/quizzes/rxjs/attempts").contentType("application/json").content("{}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.attemptReceipt").value("receipt.sig"))
                .andExpect(jsonPath("$.durationSeconds").value(120))
                // ATTEMPT_ISSUED still bans the answer key and internals.
                .andExpect(jsonPath("$.questions").doesNotExist())
                .andExpect(jsonPath("$.explanation").doesNotExist())
                .andExpect(jsonPath("$.secret").doesNotExist())
                .andExpect(header().string("X-Content-Type-Options", "nosniff"));
    }

    @Test
    void attemptsWithSyntacticallyBrokenJsonReturnsTheStandardMalformedBodyEnvelope() throws Exception {
        mockMvc.perform(post("/api/quizzes/rxjs/attempts").contentType("application/json").content("{ not json"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("BAD_REQUEST"))
                .andExpect(jsonPath("$.error.message").value("Malformed JSON body"));
        verify(service, never()).issueAttempt(any());
    }

    @Test
    void attemptsOfAnUnknownQuizReturns404() throws Exception {
        when(service.issueAttempt("nope")).thenThrow(ApiException.notFound("Quiz not found"));
        mockMvc.perform(post("/api/quizzes/nope/attempts").contentType("application/json").content("{}"))
                .andExpect(status().isNotFound());
    }

    // ── POST .../questions/start — ATTEMPT_ISSUED ────────────────────────

    @Test
    void startReturns201WithAQuestionReceipt() throws Exception {
        when(service.startQuestion(eq("rxjs"), eq("attempt-receipt"), eq("Which answer is correct?")))
                .thenReturn(new QuestionStartedDto("rxjs", "Which answer is correct?", 30,
                        1_700_000_000_000L, 1_700_000_030_000L, "question-receipt.sig"));

        mockMvc.perform(post("/api/quizzes/rxjs/questions/start")
                        .header("X-Attempt-Receipt", "attempt-receipt")
                        .contentType("application/json")
                        .content("{\"questionText\":\"Which answer is correct?\"}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.questionReceipt").value("question-receipt.sig"))
                .andExpect(jsonPath("$.durationSeconds").value(30));
    }

    @Test
    void startWithoutAnAttemptReceiptReturns401() throws Exception {
        when(service.startQuestion(eq("rxjs"), eq(null), any())).thenThrow(new AttemptReceiptException());

        mockMvc.perform(post("/api/quizzes/rxjs/questions/start")
                        .contentType("application/json").content("{\"questionText\":\"x\"}"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("UNAUTHORIZED"))
                .andExpect(jsonPath("$.error.message").value("Invalid attempt receipt"));
    }

    @Test
    void startWithAnUnknownQuestionReturns400InvalidSubmission() throws Exception {
        when(service.startQuestion(eq("rxjs"), anyString(), any())).thenThrow(new AnswerCheckException());

        mockMvc.perform(post("/api/quizzes/rxjs/questions/start")
                        .header("X-Attempt-Receipt", "attempt-receipt")
                        .contentType("application/json")
                        .content("{\"questionText\":\"No such question\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.message").value("Invalid submission"));
    }

    @Test
    void startWithSyntacticallyBrokenJsonReturnsTheStandardMalformedBodyEnvelope() throws Exception {
        mockMvc.perform(post("/api/quizzes/rxjs/questions/start")
                        .header("X-Attempt-Receipt", "attempt-receipt")
                        .contentType("application/json")
                        .content("{ not json"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.message").value("Malformed JSON body"));
        verify(service, never()).startQuestion(any(), any(), any());
    }

    // ── POST .../check — ANSWER_REVEAL ───────────────────────────────────

    @Test
    void checkReturnsResolvedOutcomeAllowingCorrectnessAndExplanationButNoIdentifiers() throws Exception {
        when(service.check(eq("rxjs"), eq("question-receipt"), eq("Which answer is correct?"), any(), anyString()))
                .thenReturn(new ResolvedCheckOutcome("resolved", true, List.of("A multicast observable"), "Because a Subject multicasts."));

        mockMvc.perform(post("/api/quizzes/rxjs/check")
                        .header("X-Question-Receipt", "question-receipt")
                        .contentType("application/json")
                        .content("{\"questionText\":\"Which answer is correct?\",\"selectedOptionTexts\":[\"A pipe\"]}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("resolved"))
                .andExpect(jsonPath("$.correct").value(true))
                // ANSWER_REVEAL's tightly-scoped widening: legal here.
                .andExpect(jsonPath("$.correctOptionTexts[0]").value("A multicast observable"))
                .andExpect(jsonPath("$.explanation").value("Because a Subject multicasts."))
                // Still banned even under ANSWER_REVEAL: identifiers and internals.
                .andExpect(jsonPath("$.questionId").doesNotExist())
                .andExpect(jsonPath("$.isCorrect").doesNotExist())
                .andExpect(jsonPath("$.correctOptionIds").doesNotExist())
                .andExpect(header().string("X-Content-Type-Options", "nosniff"));
    }

    @Test
    void checkReturnsIncompleteOutcomeWithExactlyTheApprovedKeys() throws Exception {
        when(service.check(eq("rxjs"), eq("question-receipt"), any(), any(), anyString()))
                .thenReturn(new IncompleteCheckOutcome("incomplete", List.of(new SelectedVerdict("map", true)), 1));

        mockMvc.perform(post("/api/quizzes/rxjs/check")
                        .header("X-Question-Receipt", "question-receipt")
                        .contentType("application/json")
                        .content("{\"questionText\":\"Select every operator\",\"selectedOptionTexts\":[\"map\"]}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("incomplete"))
                .andExpect(jsonPath("$.remainingCorrectCount").value(1))
                .andExpect(jsonPath("$.selectedVerdicts[0].text").value("map"))
                .andExpect(jsonPath("$.correctOptionTexts").doesNotExist())
                .andExpect(jsonPath("$.explanation").doesNotExist());
    }

    @Test
    void checkWithoutAQuestionReceiptReturns401() throws Exception {
        when(service.check(eq("rxjs"), eq(null), any(), any(), anyString())).thenThrow(new QuestionReceiptException());

        mockMvc.perform(post("/api/quizzes/rxjs/check")
                        .contentType("application/json")
                        .content("{\"questionText\":\"x\",\"selectedOptionTexts\":[]}"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.message").value("Invalid question receipt"));
    }

    @Test
    void checkWhenRateLimitedReturns429WithRetryAfterAndTheFixedEnvelope() throws Exception {
        when(service.check(eq("rxjs"), any(), any(), any(), anyString())).thenThrow(new RateLimitedException(7));

        mockMvc.perform(post("/api/quizzes/rxjs/check")
                        .header("X-Question-Receipt", "question-receipt")
                        .contentType("application/json")
                        .content("{\"questionText\":\"x\",\"selectedOptionTexts\":[]}"))
                .andExpect(status().isTooManyRequests())
                .andExpect(jsonPath("$.error.code").value("RATE_LIMITED"))
                .andExpect(jsonPath("$.error.message").value("Too many requests"))
                .andExpect(header().string("Retry-After", "7"));
    }

    @Test
    void checkWithSyntacticallyBrokenJsonReturnsTheStandardMalformedBodyEnvelope() throws Exception {
        mockMvc.perform(post("/api/quizzes/rxjs/check")
                        .header("X-Question-Receipt", "question-receipt")
                        .contentType("application/json")
                        .content("{ not json"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.message").value("Malformed JSON body"));
        verify(service, never()).check(any(), any(), any(), any(), any());
    }
}
