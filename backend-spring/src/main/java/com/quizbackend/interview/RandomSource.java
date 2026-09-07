package com.quizbackend.interview;

/** Port of the Node reference's {@code RandomSource}: a float in [0, 1). */
@FunctionalInterface
public interface RandomSource {
    double next();
}
