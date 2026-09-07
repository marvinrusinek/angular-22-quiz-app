package com.quizbackend.interview;

import com.quizbackend.interview.dto.ActiveInterviewAnswerDto;
import com.quizbackend.interview.dto.ActiveInterviewConfigDto;
import com.quizbackend.interview.dto.ActiveInterviewOptionDto;
import com.quizbackend.interview.dto.ActiveInterviewQuestionDto;
import com.quizbackend.interview.dto.ActiveInterviewSessionDto;
import com.quizbackend.interview.dto.CodeSnippetDto;
import com.quizbackend.quiz.QuizRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import java.util.List;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyMap;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * Controller/API + security-regression proof for {@code POST /api/interview-
 * sessions} and {@code GET /api/interview-sessions/{sessionId}}, against the
 * REAL Spring context with the REAL response-policy guard filter registered
 * (same pattern as {@code QuizControllerTest}) — {@link InterviewSessionService}
 * is mocked so this class needs no database, but the actual serialized JSON
 * still passes through the real guard, proving
 * {@code ResponsePolicyContext.set} is genuinely wired on both routes.
 */
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
class InterviewSessionControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @MockitoBean
    private InterviewSessionService service;

    @MockitoBean
    private QuizRepository quizRepository;
    @MockitoBean
    private InterviewQuestionRepository interviewQuestionRepository;
    @MockitoBean
    private InterviewSessionRepository interviewSessionRepository;

    private ActiveInterviewSessionDto sampleDto(String sessionToken) {
        CodeSnippetDto snippet = new CodeSnippetDto("typescript", "const s = signal(0);", null);
        ActiveInterviewQuestionDto question = new ActiveInterviewQuestionDto(
                "signals:q:0", "signals", "What does this log?", "single",
                List.of(new ActiveInterviewOptionDto(101, "0"), new ActiveInterviewOptionDto(102, "1")),
                false, snippet);
        ActiveInterviewConfigDto config = new ActiveInterviewConfigDto("preset", "junior", null, List.of("signals"), 1);
        List<ActiveInterviewAnswerDto> answers = List.of();
        return new ActiveInterviewSessionDto("is_abc123", sessionToken, "active",
                "2024-01-01T00:00:00.000Z", "2024-01-01T00:20:00.000Z", 1200, 1200, config,
                List.of(question), answers);
    }

    @Test
    void createReturns201WithASessionTokenAndNoCorrectnessOrExplanation() throws Exception {
        when(service.createSession(anyMap())).thenReturn(sampleDto("raw-token-abc"));

        mockMvc.perform(post("/api/interview-sessions")
                        .contentType("application/json")
                        .content("{\"mode\":\"preset\",\"presetId\":\"junior\"}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.sessionToken").value("raw-token-abc"))
                .andExpect(jsonPath("$.questions[0].codeSnippet.language").value("typescript"))
                .andExpect(jsonPath("$.questions[0].explanation").doesNotExist())
                .andExpect(jsonPath("$.questions[0].options[0].isCorrect").doesNotExist())
                .andExpect(jsonPath("$.questions[0].options[0].correct").doesNotExist());
    }

    @Test
    void resumeReturns200WithoutASessionTokenAndCarriesNosniff() throws Exception {
        when(service.resumeSession(eq("is_abc123"), any())).thenReturn(sampleDto(null));

        mockMvc.perform(get("/api/interview-sessions/is_abc123")
                        .header("Authorization", "Bearer " + "x".repeat(43)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.sessionToken").doesNotExist())
                .andExpect(header().string("X-Content-Type-Options", "nosniff"));
    }

    @Test
    void resumeWithoutAnAuthorizationHeaderReturns401WithTheGenericErrorBody() throws Exception {
        when(service.resumeSession(eq("is_abc123"), eq(null)))
                .thenThrow(SessionServiceException.unauthorized());

        mockMvc.perform(get("/api/interview-sessions/is_abc123"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("UNAUTHORIZED"))
                .andExpect(jsonPath("$.error.message").value("Invalid session credentials"));
    }

    @Test
    void resumeOfAnExpiredSessionReturns409WithSessionExpiredCode() throws Exception {
        when(service.resumeSession(eq("is_abc123"), any()))
                .thenThrow(new SessionServiceException(SessionServiceException.Code.SESSION_EXPIRED, "This assessment has expired"));

        mockMvc.perform(get("/api/interview-sessions/is_abc123")
                        .header("Authorization", "Bearer " + "x".repeat(43)))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code").value("SESSION_EXPIRED"));
    }

    @Test
    void createWithAMissingModeReturns400() throws Exception {
        when(service.createSession(anyMap()))
                .thenThrow(new SessionServiceException(SessionServiceException.Code.BAD_REQUEST, "mode must be \"preset\" or \"custom\""));

        mockMvc.perform(post("/api/interview-sessions").contentType("application/json").content("{}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("BAD_REQUEST"));
    }
}
