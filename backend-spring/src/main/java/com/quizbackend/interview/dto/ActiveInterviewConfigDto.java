package com.quizbackend.interview.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;

@JsonInclude(JsonInclude.Include.NON_NULL)
public record ActiveInterviewConfigDto(
        String mode,
        String presetId,
        String difficulty,
        List<String> topicIds,
        int questionCount
) {
}
