package com.quizbackend.web.cors;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Structural proof for {@link AllowedOrigins} — port of Node's {@code parseAllowedOrigins}. */
class AllowedOriginsTest {

    @Test
    void anUnsetValueResolvesToAnEmptyAllowList() {
        // Deliberate Spring-side adaptation: no dev-default fallback (see the
        // class javadoc) — empty means "no extra static origins", not "*".
        assertThat(new AllowedOrigins("").asSet()).isEmpty();
    }

    @Test
    void parsesACommaSeparatedList() {
        AllowedOrigins origins = new AllowedOrigins("https://a.example, https://b.example");
        assertThat(origins.contains("https://a.example")).isTrue();
        assertThat(origins.contains("https://b.example")).isTrue();
        assertThat(origins.contains("https://c.example")).isFalse();
    }

    @Test
    void trimsWhitespaceAroundEntries() {
        assertThat(new AllowedOrigins("  https://a.example  ").contains("https://a.example")).isTrue();
    }

    @Test
    void ignoresBlankEntriesFromTrailingCommas() {
        assertThat(new AllowedOrigins("https://a.example,,").asSet()).containsExactly("https://a.example");
    }

    @Test
    void matchIsExactNeverAPattern() {
        AllowedOrigins origins = new AllowedOrigins("https://a.example");
        assertThat(origins.contains("https://sub.a.example")).isFalse();
        assertThat(origins.contains("http://a.example")).isFalse(); // scheme matters
    }

    @Test
    void rejectsALiteralWildcard() {
        assertThatThrownBy(() -> new AllowedOrigins("*"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("must not contain \"*\"");
    }

    @Test
    void rejectsAnEntryWithAPath() {
        assertThatThrownBy(() -> new AllowedOrigins("https://a.example/path"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("must be scheme://host[:port] with no path");
    }

    @Test
    void rejectsAnEntryWithAQueryString() {
        assertThatThrownBy(() -> new AllowedOrigins("https://a.example?x=1"))
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    void rejectsAnUnparseableEntry() {
        assertThatThrownBy(() -> new AllowedOrigins("not a url"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("is not a valid URL");
    }

    @Test
    void acceptsAnExplicitPortInTheOrigin() {
        assertThat(new AllowedOrigins("http://localhost:4200").contains("http://localhost:4200")).isTrue();
    }
}
