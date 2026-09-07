package com.quizbackend.health;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import com.quizbackend.interview.InterviewQuestionRepository;
import com.quizbackend.interview.InterviewSessionRepository;
import com.quizbackend.quiz.QuizRepository;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * Parity proof against the Node reference's {@code GET /api/health}
 * ({@code backend/src/routes/health.route.ts}): {@code {"status":"ok",
 * "uptimeSeconds":<int>}}, nothing else.
 */
// "test" excludes datasource/JPA autoconfiguration (Slice 2) so this class
// never needs a real Neon connection to run.
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
class HealthControllerTest {

    @Autowired
    private MockMvc mockMvc;

    // Slice 2 excludes JPA/DataSource autoconfiguration under "test" (see
    // application-test.properties), so QuizRepository has no real bean. This
    // class does not exercise quiz behavior, but QuizController/QuizService
    // are still real, component-scanned beans in the same application
    // context and need SOME QuizRepository to construct — a mock is enough.
    @MockitoBean
    private QuizRepository quizRepository;

    // Slice 3 adds InterviewQuestionRepository/InterviewSessionRepository
    // (both JdbcTemplate-backed, same "no real bean under test profile"
    // situation as QuizRepository above) — mocked for the same reason.
    @MockitoBean
    private InterviewQuestionRepository interviewQuestionRepository;

    @MockitoBean
    private InterviewSessionRepository interviewSessionRepository;

    @Test
    void returns200WithTheExactPublicContractShape() throws Exception {
        mockMvc.perform(get("/api/health"))
                .andExpect(status().isOk())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
                .andExpect(jsonPath("$.status").value("ok"))
                .andExpect(jsonPath("$.uptimeSeconds").isNumber())
                // Exactly two fields — nothing else leaks into the most exposed
                // route on the service.
                .andExpect(jsonPath("$.length()").value(2));
    }
}
