package com.quizbackend.interview;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

/**
 * Cross-validated against the ACTUAL Node reference implementation, not a
 * theoretical re-derivation: the expected values below were produced by
 * running the real {@code seededRandomSource}/{@code shuffleArrayInPlace}
 * from {@code backend/src/interview/assessment.random.ts} with seed 42 via
 * {@code node -e "..."} during this slice's implementation, then pasted here
 * as literals. If this test ever fails, the Java port has drifted from Node,
 * not the other way around.
 */
class AssessmentRandomTest {

    @Test
    void seededSourceProducesTheExactNodeDrawSequenceForSeed42() {
        RandomSource random = AssessmentRandom.seeded(42);
        double[] expected = {
                0.6011037519201636, 0.44829055899754167, 0.8524657934904099, 0.6697340414393693,
                0.17481389874592423, 0.5265925421845168, 0.2732279943302274, 0.6247446539346129
        };
        for (double value : expected) {
            assertThat(random.next()).isCloseTo(value, within(1e-15));
        }
    }

    @Test
    void shuffleInPlaceMatchesTheExactNodeResultForSeed42() {
        List<Integer> list = new ArrayList<>(List.of(0, 1, 2, 3, 4, 5, 6, 7, 8, 9));
        List<Integer> shuffled = AssessmentRandom.shuffleInPlace(list, AssessmentRandom.seeded(42));
        assertThat(shuffled).containsExactly(0, 7, 3, 5, 2, 1, 8, 9, 4, 6);
    }

    @Test
    void shuffleInPlaceMutatesAndReturnsTheSameListReference() {
        List<Integer> list = new ArrayList<>(List.of(1, 2, 3));
        List<Integer> result = AssessmentRandom.shuffleInPlace(list, AssessmentRandom.seeded(1));
        assertThat(result).isSameAs(list);
    }

    @Test
    void fixedSourceReplaysValuesThenThrowsWhenExhausted() {
        RandomSource random = AssessmentRandom.fixed(0.1, 0.2);
        assertThat(random.next()).isEqualTo(0.1);
        assertThat(random.next()).isEqualTo(0.2);
        org.junit.jupiter.api.Assertions.assertThrows(IllegalStateException.class, random::next);
    }

    @Test
    void cryptoSourceProducesValuesInTheUnitInterval() {
        for (int i = 0; i < 20; i++) {
            double value = AssessmentRandom.CRYPTO.next();
            assertThat(value).isGreaterThanOrEqualTo(0.0).isLessThan(1.0);
        }
    }
}
