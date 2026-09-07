package com.quizbackend.interview.dto;

public record InterviewPerformanceBucketDto(
        String topicId, String title, int correct, int incorrect, int unanswered, int total, int percentage
) {
}
