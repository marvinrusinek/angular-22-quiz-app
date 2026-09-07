package com.quizbackend.quiz.topicquiz;

/** Port of the Node reference's {@code AnswerCheckError}. One shared message — the client must not learn WHICH part failed. */
public class AnswerCheckException extends RuntimeException {
    public AnswerCheckException() {
        super("Invalid submission");
    }
}
