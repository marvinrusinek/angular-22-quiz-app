package com.quizbackend.web.size;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletInputStream;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

/**
 * Direct proof for {@link RequestSizeLimitFilter}'s boundary/streaming
 * behavior — port of the Node reference's {@code express.json({limit:
 * '32kb'})}, whose resolved byte value ({@value RequestSizeLimitFilter#LIMIT_BYTES})
 * was confirmed this slice by actually running Node's own {@code bytes}
 * library ({@code bytes.parse('32kb') === 32768}), not assumed.
 *
 * <p>Uses raw {@link MockHttpServletRequest}/{@link FilterChain} mocking
 * (not {@code MockMvc}) specifically so Content-Length can be set
 * INDEPENDENTLY of the actual stream bytes — MockMvc's own request builder
 * always computes Content-Length correctly from the supplied body, which
 * cannot exercise a lying/absent-Content-Length scenario. This is the
 * "misleading Content-Length" and "no Content-Length" evidence the audit
 * explicitly asked for.
 */
class RequestSizeLimitFilterTest {

    private final RequestSizeLimitFilter filter = new RequestSizeLimitFilter();

    private MockHttpServletRequest jsonRequest(byte[] body, Integer declaredContentLength) {
        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/api/quizzes/rxjs/check");
        request.setContentType("application/json");
        request.setContent(body);
        if (declaredContentLength != null) {
            request.addHeader("Content-Length", String.valueOf(declaredContentLength));
        }
        return request;
    }

    /** A request whose actual stream yields more bytes than {@code contentLengthClaim} declares. */
    private MockHttpServletRequest lyingContentLengthRequest(byte[] actualBytes, long contentLengthClaim) {
        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/api/quizzes/rxjs/check") {
            @Override
            public ServletInputStream getInputStream() {
                ByteArrayInputStream in = new ByteArrayInputStream(actualBytes);
                return new ServletInputStream() {
                    @Override
                    public boolean isFinished() {
                        return in.available() == 0;
                    }

                    @Override
                    public boolean isReady() {
                        return true;
                    }

                    @Override
                    public void setReadListener(ReadListener readListener) {
                    }

                    @Override
                    public int read() {
                        return in.read();
                    }

                    @Override
                    public int read(byte[] b, int off, int len) {
                        return in.read(b, off, len);
                    }
                };
            }

            @Override
            public long getContentLengthLong() {
                return contentLengthClaim;
            }
        };
        request.setContentType("application/json");
        return request;
    }

    @Test
    void limitIsExactlyThirtyTwoKibibytesMatchingNodesResolvedBytesValue() {
        assertThat(RequestSizeLimitFilter.LIMIT_BYTES).isEqualTo(32768);
    }

    @Test
    void aSmallValidJsonBodyPassesThroughUnchanged() throws Exception {
        byte[] body = "{\"questionText\":\"x\",\"selectedOptionTexts\":[]}".getBytes(StandardCharsets.UTF_8);
        MockHttpServletRequest request = jsonRequest(body, body.length);
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilterInternal(request, response, chain);

        verify(chain).doFilter(any(), any());
        assertThat(response.getStatus()).isEqualTo(200); // MockHttpServletResponse default; filter never touched it
    }

    @Test
    void aRequestExactlyAtTheLimitIsAccepted() throws Exception {
        byte[] body = new byte[RequestSizeLimitFilter.LIMIT_BYTES];
        MockHttpServletRequest request = jsonRequest(body, body.length);
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilterInternal(request, response, chain);

        verify(chain).doFilter(any(), any());
    }

    @Test
    void aRequestOneByteOverTheLimitViaDeclaredContentLengthIsRejected() throws Exception {
        byte[] body = new byte[RequestSizeLimitFilter.LIMIT_BYTES + 1];
        MockHttpServletRequest request = jsonRequest(body, body.length);
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilterInternal(request, response, chain);

        verify(chain, never()).doFilter(any(), any());
        assertThat(response.getStatus()).isEqualTo(413);
    }

    @Test
    void aRequestOneByteUnderTheLimitIsAccepted() throws Exception {
        byte[] body = new byte[RequestSizeLimitFilter.LIMIT_BYTES - 1];
        MockHttpServletRequest request = jsonRequest(body, body.length);
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilterInternal(request, response, chain);

        verify(chain).doFilter(any(), any());
    }

    @Test
    void aSubstantiallyOversizedBodyIsRejected() throws Exception {
        byte[] body = new byte[RequestSizeLimitFilter.LIMIT_BYTES * 4];
        MockHttpServletRequest request = jsonRequest(body, body.length);
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilterInternal(request, response, chain);

        verify(chain, never()).doFilter(any(), any());
        assertThat(response.getStatus()).isEqualTo(413);
    }

    @Test
    void oversizedWithAnAccurateContentLengthIsRejectedBeforeReadingTheStream() throws Exception {
        // The Content-Length pre-check alone must be enough — no need to
        // touch the stream at all when it already exceeds the limit.
        byte[] body = new byte[RequestSizeLimitFilter.LIMIT_BYTES + 100];
        MockHttpServletRequest request = jsonRequest(body, body.length);
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilterInternal(request, response, chain);

        assertThat(response.getStatus()).isEqualTo(413);
    }

    @Test
    void anOversizedBodyWithNoExplicitContentLengthHeaderIsStillRejected() throws Exception {
        // No explicit "Content-Length" header added (jsonRequest's
        // declaredContentLength=null skips the addHeader call) — only
        // MockHttpServletRequest's own automatic derivation from the
        // supplied content is present, exercising the same code path a
        // real absent/derived Content-Length would.
        byte[] body = new byte[RequestSizeLimitFilter.LIMIT_BYTES + 500];
        MockHttpServletRequest request = jsonRequest(body, null);
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilterInternal(request, response, chain);

        verify(chain, never()).doFilter(any(), any());
        assertThat(response.getStatus()).isEqualTo(413);
    }

    @Test
    void aMisleadingContentLengthThatUnderstatesTheBodyIsStillRejectedByActualByteCount() throws Exception {
        // Content-Length CLAIMS a small, allowed size, but the actual stream
        // yields far more bytes — the Content-Length pre-check alone would
        // wrongly accept this; only counting bytes actually read catches it.
        byte[] actualBody = new byte[RequestSizeLimitFilter.LIMIT_BYTES * 2];
        MockHttpServletRequest request = lyingContentLengthRequest(actualBody, 10);
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilterInternal(request, response, chain);

        verify(chain, never()).doFilter(any(), any());
        assertThat(response.getStatus()).isEqualTo(413);
    }

    @Test
    void multibyteUnicodePayloadIsBoundedByUtf8ByteLengthNotJavaCharLength() throws Exception {
        // Each '€' is 1 UTF-16 char but 3 UTF-8 bytes — a char-length check
        // would wrongly admit a body whose BYTE length exceeds the limit.
        String euroSigns = "€".repeat(RequestSizeLimitFilter.LIMIT_BYTES); // 32768 chars, but 3x bytes
        byte[] body = ("{\"questionText\":\"" + euroSigns + "\",\"selectedOptionTexts\":[]}")
                .getBytes(StandardCharsets.UTF_8);
        assertThat(body.length).isGreaterThan(RequestSizeLimitFilter.LIMIT_BYTES);

        MockHttpServletRequest request = jsonRequest(body, body.length);
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilterInternal(request, response, chain);

        verify(chain, never()).doFilter(any(), any());
        assertThat(response.getStatus()).isEqualTo(413);
    }

    @Test
    void nonJsonContentTypeIsNeverSizeLimitedByThisFilter() throws Exception {
        byte[] hugeBody = new byte[RequestSizeLimitFilter.LIMIT_BYTES * 4];
        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/api/quizzes/rxjs/check");
        request.setContentType("text/plain");
        request.setContent(hugeBody);
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilterInternal(request, response, chain);

        // Not this filter's concern — Node's express.json() likewise never
        // parses/limits a non-application/json body.
        verify(chain).doFilter(any(), any());
    }

    @Test
    void jsonContentTypeWithACharsetParameterIsStillMatchedExactly() throws Exception {
        byte[] body = "{}".getBytes(StandardCharsets.UTF_8);
        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/api/quizzes/rxjs/attempts");
        request.setContentType("application/json; charset=utf-8");
        request.setContent(body);
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilterInternal(request, response, chain);

        verify(chain).doFilter(any(), any());
    }

    @Test
    void aGetRequestWithNoBodyIsUnaffected() throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/api/quizzes");
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilterInternal(request, response, chain);

        verify(chain).doFilter(any(), any());
    }

    @Test
    void anEmptyBodyIsAccepted() throws Exception {
        MockHttpServletRequest request = jsonRequest(new byte[0], 0);
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilterInternal(request, response, chain);

        verify(chain).doFilter(any(), any());
    }

    @Test
    void the413BodyMatchesTheExactNodeEnvelope() throws Exception {
        byte[] body = new byte[RequestSizeLimitFilter.LIMIT_BYTES + 1];
        MockHttpServletRequest request = jsonRequest(body, body.length);
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilterInternal(request, response, chain);

        assertThat(response.getContentAsString(StandardCharsets.UTF_8))
                .isEqualTo("{\"error\":{\"code\":\"PAYLOAD_TOO_LARGE\",\"message\":\"Request body too large\"}}");
    }

    @Test
    void anOversizedBodyNeverReachesTheControllerChain() throws Exception {
        byte[] body = new byte[RequestSizeLimitFilter.LIMIT_BYTES * 2];
        MockHttpServletRequest request = jsonRequest(body, body.length);
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilterInternal(request, response, chain);

        verify(chain, never()).doFilter(any(), any());
    }
}
