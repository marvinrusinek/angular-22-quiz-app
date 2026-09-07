package com.quizbackend.interview;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class AllOfTheAboveTest {

    @Test
    void matchesTheExactPhraseCaseInsensitively() {
        assertThat(AllOfTheAbove.isAllOfTheAbove("All of the above")).isTrue();
        assertThat(AllOfTheAbove.isAllOfTheAbove("ALL OF THE ABOVE")).isTrue();
    }

    @Test
    void matchesWithHtmlTagsAndNbspStripped() {
        assertThat(AllOfTheAbove.isAllOfTheAbove("<b>All&nbsp;of the above</b>")).isTrue();
    }

    @Test
    void matchesWithCollapsedWhitespaceAndTrailingPunctuation() {
        assertThat(AllOfTheAbove.isAllOfTheAbove("All   of the  above.")).isTrue();
    }

    @Test
    void doesNotMatchAnUnrelatedOption() {
        assertThat(AllOfTheAbove.isAllOfTheAbove("A reactive wrapper around a value")).isFalse();
    }

    @Test
    void doesNotMatchNull() {
        assertThat(AllOfTheAbove.isAllOfTheAbove(null)).isFalse();
    }
}
