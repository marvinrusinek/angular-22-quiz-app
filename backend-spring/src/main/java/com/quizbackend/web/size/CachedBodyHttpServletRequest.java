package com.quizbackend.web.size;

import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;

/**
 * Replays an already-read, size-bounded body so downstream Spring/Jackson
 * body parsing works exactly as if the raw servlet input stream had never
 * been consumed by {@link RequestSizeLimitFilter}. The body was already
 * fully read (and found to be within the size limit) by the time this
 * wrapper is constructed — nothing here re-reads the underlying connection.
 */
final class CachedBodyHttpServletRequest extends HttpServletRequestWrapper {

    private final byte[] body;

    CachedBodyHttpServletRequest(HttpServletRequest request, byte[] body) {
        super(request);
        this.body = body;
    }

    @Override
    public ServletInputStream getInputStream() {
        ByteArrayInputStream byteStream = new ByteArrayInputStream(body);
        return new ServletInputStream() {
            @Override
            public boolean isFinished() {
                return byteStream.available() == 0;
            }

            @Override
            public boolean isReady() {
                return true;
            }

            @Override
            public void setReadListener(ReadListener readListener) {
                // Synchronous, already-buffered body — nothing to notify.
            }

            @Override
            public int read() {
                return byteStream.read();
            }

            @Override
            public int read(byte[] b, int off, int len) {
                return byteStream.read(b, off, len);
            }
        };
    }

    @Override
    public BufferedReader getReader() throws IOException {
        String encoding = getCharacterEncoding() != null ? getCharacterEncoding() : StandardCharsets.UTF_8.name();
        return new BufferedReader(new InputStreamReader(getInputStream(), encoding));
    }
}
