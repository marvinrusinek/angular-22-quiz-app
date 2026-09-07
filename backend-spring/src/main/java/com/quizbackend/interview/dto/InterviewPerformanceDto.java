package com.quizbackend.interview.dto;

import java.util.List;

/** Port of the Node reference's {@code { performance: { byTopic } } } nesting. */
public record InterviewPerformanceDto(List<InterviewPerformanceBucketDto> byTopic) {
}
