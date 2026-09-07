package com.quizbackend.interview;

import java.util.List;

public record InterviewSessionSnapshot(InterviewSessionRecord session, List<SessionQuestionSnapshot> questions) {
}
