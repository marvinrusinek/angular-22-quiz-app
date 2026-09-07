package com.quizbackend;

import com.quizbackend.interview.InterviewQuestionRepository;
import com.quizbackend.interview.InterviewSessionRepository;
import com.quizbackend.quiz.QuizRepository;
import com.quizbackend.quiz.QuizResourceRepository;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

// "test" excludes datasource/JPA autoconfiguration (see application-test.properties)
// so this plain context-load smoke test never needs a real Neon connection.
@SpringBootTest
@ActiveProfiles("test")
class QuizBackendApplicationTests {

	// QuizController/QuizService are real beans needing a QuizRepository to
	// construct even though this test only proves the context loads.
	@MockitoBean
	private QuizRepository quizRepository;

	@MockitoBean
	private InterviewQuestionRepository interviewQuestionRepository;

	@MockitoBean
	private InterviewSessionRepository interviewSessionRepository;

	@MockitoBean
	private QuizResourceRepository quizResourceRepository;

	@Test
	void contextLoads() {
	}

}
