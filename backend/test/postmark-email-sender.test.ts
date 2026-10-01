import type { CertificatePostmarkConfig } from '../src/config';
import type { OutboundEmail } from '../src/certificate/email-sender';
import { describePostmarkConfig, PostmarkEmailSender, PostmarkSendError } from '../src/certificate/postmark-email-sender';

/**
 * No real network I/O — global fetch is replaced with a mock for every
 * test, so each one controls exactly what Postmark "returned." Real
 * connectivity is not applicable here the way it was for SMTP (plain
 * outbound HTTPS, not a provider-specific protocol handshake to verify
 * separately) — what matters is that THIS adapter builds the request
 * Postmark's own documented contract expects and classifies every
 * documented response/failure shape correctly.
 */
const REAL_TOKEN = 'pm-server-token-DO-NOT-LOG-this-value';

const POSTMARK_CONFIG: CertificatePostmarkConfig = { serverToken: REAL_TOKEN, messageStream: 'outbound' };

const SAMPLE_MESSAGE: OutboundEmail = {
  idempotencyKey: 'claimant_verify:cc_1:0',
  to: 'claimant@example.com',
  kind: 'claimant_verify',
  templateData: { recipientName: 'Ada Lovelace', verificationUrl: 'https://example.test/verify#token=abc123' }
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body)
  } as Response;
}

let fetchMock: jest.Mock;
const originalFetch = global.fetch;

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = originalFetch;
});

describe('PostmarkEmailSender — request shape', () => {
  it('POSTs to the exact documented endpoint with the server token header, never an account token field', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { To: 'claimant@example.com', SubmittedAt: '2026-01-01T00:00:00Z', MessageID: 'msg-1', ErrorCode: 0, Message: 'OK' }));
    const sender = new PostmarkEmailSender({ postmark: POSTMARK_CONFIG, fromAddress: 'certificates@marvinrusinek.com' });

    await sender.send(SAMPLE_MESSAGE);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.postmarkapp.com/email');
    expect(init.method).toBe('POST');
    expect(init.headers['X-Postmark-Server-Token']).toBe(REAL_TOKEN);
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers).not.toHaveProperty('X-Postmark-Account-Token');
  });

  it('includes both TextBody and HtmlBody, and the configured MessageStream', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ErrorCode: 0, MessageID: 'msg-1', Message: 'OK', To: 'x', SubmittedAt: 'x' }));
    const sender = new PostmarkEmailSender({ postmark: { ...POSTMARK_CONFIG, messageStream: 'certificate-notifications' }, fromAddress: 'certificates@marvinrusinek.com' });

    await sender.send(SAMPLE_MESSAGE);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.TextBody).toContain('https://example.test/verify#token=abc123');
    expect(body.HtmlBody).toContain('https://example.test/verify#token=abc123');
    expect(body.MessageStream).toBe('certificate-notifications');
    expect(body.From).toBe('certificates@marvinrusinek.com');
    expect(body.To).toBe('claimant@example.com');
  });

  it('EXPLICITLY disables open and link tracking — never left at a provider default', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ErrorCode: 0, MessageID: 'msg-1', Message: 'OK', To: 'x', SubmittedAt: 'x' }));
    const sender = new PostmarkEmailSender({ postmark: POSTMARK_CONFIG, fromAddress: 'certificates@marvinrusinek.com' });

    await sender.send(SAMPLE_MESSAGE);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.TrackOpens).toBe(false);
    expect(body.TrackLinks).toBe('None');
  });

  it('passes the idempotencyKey as a forensic header only, in the documented Headers array shape', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ErrorCode: 0, MessageID: 'msg-1', Message: 'OK', To: 'x', SubmittedAt: 'x' }));
    const sender = new PostmarkEmailSender({ postmark: POSTMARK_CONFIG, fromAddress: 'certificates@marvinrusinek.com' });

    await sender.send(SAMPLE_MESSAGE);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.Headers).toContainEqual({ Name: 'X-Certificate-Idempotency-Key', Value: 'claimant_verify:cc_1:0' });
  });

  it('a bounded timeout is attached to the request (AbortSignal)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ErrorCode: 0, MessageID: 'msg-1', Message: 'OK', To: 'x', SubmittedAt: 'x' }));
    const sender = new PostmarkEmailSender({ postmark: POSTMARK_CONFIG, fromAddress: 'certificates@marvinrusinek.com' });

    await sender.send(SAMPLE_MESSAGE);

    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('describePostmarkConfig — safe for logs', () => {
  it('never includes the server token', () => {
    const description = describePostmarkConfig(POSTMARK_CONFIG);
    expect(description).not.toContain(REAL_TOKEN);
    expect(description).toContain('outbound');
  });
});

describe('PostmarkEmailSender — successful delivery response', () => {
  it('ErrorCode 0 → delivered:true with the MessageID', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { To: 'claimant@example.com', SubmittedAt: '2026-01-01T00:00:00Z', MessageID: 'real-message-id', ErrorCode: 0, Message: 'OK' }));
    const sender = new PostmarkEmailSender({ postmark: POSTMARK_CONFIG, fromAddress: 'certificates@marvinrusinek.com' });

    const result = await sender.send(SAMPLE_MESSAGE);

    expect(result).toEqual({ delivered: true, providerMessageId: 'real-message-id' });
  });
});

describe('PostmarkEmailSender — malformed and error responses', () => {
  const sender = () => new PostmarkEmailSender({ postmark: POSTMARK_CONFIG, fromAddress: 'certificates@marvinrusinek.com' });

  it('a non-JSON body (e.g. an upstream proxy error page) throws a classified error, never an unhandled SyntaxError', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502, text: async () => '<html>Bad Gateway</html>' } as Response);
    await expect(sender().send(SAMPLE_MESSAGE)).rejects.toBeInstanceOf(PostmarkSendError);
  });

  it('HTTP 401 (bad/missing token) → kind "auth"', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { ErrorCode: 10, Message: 'Bad or missing API token' }));
    await expect(sender().send(SAMPLE_MESSAGE)).rejects.toMatchObject({ kind: 'auth' });
  });

  it('HTTP 429 (rate limit) → kind "transient"', async () => {
    fetchMock.mockResolvedValue(jsonResponse(429, { ErrorCode: 429, Message: 'Rate limit exceeded' }));
    await expect(sender().send(SAMPLE_MESSAGE)).rejects.toMatchObject({ kind: 'transient' });
  });

  it('ErrorCode 406 (inactive/suppressed recipient) → kind "permanent" — retrying will not help', async () => {
    fetchMock.mockResolvedValue(jsonResponse(422, { ErrorCode: 406, Message: 'Inactive recipient' }));
    await expect(sender().send(SAMPLE_MESSAGE)).rejects.toMatchObject({ kind: 'permanent' });
  });

  it('ErrorCode 412 (account pending approval) → kind "permanent" for THIS attempt', async () => {
    fetchMock.mockResolvedValue(jsonResponse(422, { ErrorCode: 412, Message: 'Account is Pending' }));
    await expect(sender().send(SAMPLE_MESSAGE)).rejects.toMatchObject({ kind: 'permanent' });
  });

  it('ErrorCode 1236 (sending not supported on this MessageStream) → kind "permanent" — a config mistake', async () => {
    fetchMock.mockResolvedValue(jsonResponse(422, { ErrorCode: 1236, Message: "Sending is not supported on the supplied 'MessageStream'" }));
    await expect(sender().send(SAMPLE_MESSAGE)).rejects.toMatchObject({ kind: 'permanent' });
  });

  it('HTTP 5xx → kind "transient"', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { ErrorCode: 0, Message: 'Internal Server Error' }));
    await expect(sender().send(SAMPLE_MESSAGE)).rejects.toMatchObject({ kind: 'transient' });
  });

  it('a network-level fetch rejection (e.g. DNS failure) → kind "transient"', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(sender().send(SAMPLE_MESSAGE)).rejects.toMatchObject({ kind: 'transient' });
  });

  it('an AbortSignal timeout firing → kind "timeout", distinguishable from a generic network failure', async () => {
    const timeoutError = new Error('The operation was aborted');
    timeoutError.name = 'TimeoutError';
    fetchMock.mockRejectedValue(timeoutError);
    await expect(sender().send(SAMPLE_MESSAGE)).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('every thrown error is a PostmarkSendError instance of Error (caught correctly by the dispatcher\'s own try/catch)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { ErrorCode: 10, Message: 'Bad or missing API token' }));
    await expect(sender().send(SAMPLE_MESSAGE)).rejects.toBeInstanceOf(Error);
  });
});

describe('PostmarkEmailSender — secret redaction', () => {
  it('no thrown error, for ANY failure kind, ever contains the server token', async () => {
    const scenarios: Array<() => void> = [
      () => fetchMock.mockResolvedValueOnce(jsonResponse(401, { ErrorCode: 10, Message: 'Bad or missing API token' })),
      () => fetchMock.mockResolvedValueOnce(jsonResponse(429, { ErrorCode: 429, Message: 'Rate limit exceeded' })),
      () => fetchMock.mockResolvedValueOnce(jsonResponse(422, { ErrorCode: 406, Message: 'Inactive recipient' })),
      () => fetchMock.mockResolvedValueOnce(jsonResponse(500, { ErrorCode: 0, Message: 'Internal Server Error' })),
      () => fetchMock.mockRejectedValueOnce(new TypeError('fetch failed')),
      () => fetchMock.mockResolvedValueOnce({ ok: false, status: 502, text: async () => 'not json' } as Response)
    ];
    for (const setup of scenarios) {
      setup();
      const sender = new PostmarkEmailSender({ postmark: POSTMARK_CONFIG, fromAddress: 'certificates@marvinrusinek.com' });
      try {
        await sender.send(SAMPLE_MESSAGE);
        throw new Error('expected send() to throw');
      } catch (err: unknown) {
        expect((err as Error).message).not.toContain(REAL_TOKEN);
      }
    }
  });

  it('successful-send result fields never echo the server token', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { To: 'claimant@example.com', SubmittedAt: '2026-01-01T00:00:00Z', MessageID: 'real-id', ErrorCode: 0, Message: 'OK' }));
    const sender = new PostmarkEmailSender({ postmark: POSTMARK_CONFIG, fromAddress: 'certificates@marvinrusinek.com' });
    const result = await sender.send(SAMPLE_MESSAGE);
    expect(JSON.stringify(result)).not.toContain(REAL_TOKEN);
  });
});
