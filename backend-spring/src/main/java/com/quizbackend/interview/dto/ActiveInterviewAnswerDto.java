package com.quizbackend.interview.dto;

import java.util.List;

public record ActiveInterviewAnswerDto(String questionId, List<Integer> selectedOptionIds) {
}
