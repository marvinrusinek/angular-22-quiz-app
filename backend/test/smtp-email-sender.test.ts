import type { CertificateSmtpConfig } from '../src/config';
import type { OutboundEmail } from '../src/certificate/email-sender';

/**
 * Nodemailer itself is NOT exercised here — no real network I/O, no real
 * SMTP server. `createTransport` is mocked so every test controls exactly
 * what `sendMail` does, which is what makes auth-failure/timeout/permanent-
 * error paths deterministically testable without a live server. Real
 * connectivity (TCP connect, STARTTLS handshake, certificate chain) was
 * verified separately and directly against the actual production target
 * (Winhost's m07.internetmailserver.net:587) — see
 * docs/certificate-claims-runbook.md.
 */
const sendMailMock = jest.fn();
const createTransportMock = jest.fn(() => ({ sendMail: sendMailMock }));
jest.mock('nodemailer', () => ({
  __esModule: true,
  default: { createTransport: () => createTransportMock() }
}));

import { buildSmtpTransportOptions, describeSmtpConfig, SmtpEmailSender, SmtpSendError } from '../src/certificate/smtp-email-sender';

const REAL_PASSWORD = 'correct-horse-battery-staple-DO-NOT-LOG';

const STARTTLS_CONFIG: CertificateSmtpConfig = {
  host: 'm07.internetmailserver.net',
  port: 587,
  tlsMode: 'starttls',
  username: 'marvin@marvinrusinek.com',
  password: REAL_PASSWORD
};

const IMPLICIT_TLS_CONFIG: CertificateSmtpConfig = { ...STARTTLS_CONFIG, tlsMode: 'tls', port: 465 };

const SAMPLE_MESSAGE: OutboundEmail = {
  idempotencyKey: 'claimant_verify:cc_1:0',
  to: 'claimant@example.com',
  kind: 'claimant_verify',
  templateData: { recipientName: 'Ada Lovelace', verificationUrl: 'https://example.test/verify#token=abc123' }
};

beforeEach(() => {
  sendMailMock.mockReset();
  createTransportMock.mockClear();
});

describe('buildSmtpTransportOptions — TLS requirements', () => {
  it('starttls mode: requireTLS true, secure false (mandatory upgrade after connecting on the conventional submission port)', () => {
    const opts = buildSmtpTransportOptions(STARTTLS_CONFIG);
    expect(opts.secure).toBe(false);
    expect(opts.requireTLS).toBe(true);
  });

  it('tls mode: secure true, requireTLS false (implicit TLS from the first byte)', () => {
    const opts = buildSmtpTransportOptions(IMPLICIT_TLS_CONFIG);
    expect(opts.secure).toBe(true);
    expect(opts.requireTLS).toBe(false);
  });

  it('certificate validation is ALWAYS on, for both modes — never configurable, never disabled', () => {
    expect(buildSmtpTransportOptions(STARTTLS_CONFIG).tls?.rejectUnauthorized).toBe(true);
    expect(buildSmtpTransportOptions(IMPLICIT_TLS_CONFIG).tls?.rejectUnauthorized).toBe(true);
  });

  it('enforces a TLS 1.2 floor', () => {
    expect(buildSmtpTransportOptions(STARTTLS_CONFIG).tls?.minVersion).toBe('TLSv1.2');
  });

  it('carries the configured host, port, and auth credentials through unchanged', () => {
    const opts = buildSmtpTransportOptions(STARTTLS_CONFIG);
    expect(opts.host).toBe('m07.internetmailserver.net');
    expect(opts.port).toBe(587);
    expect(opts.auth).toEqual({ user: 'marvin@marvinrusinek.com', pass: REAL_PASSWORD });
  });

  it('sets bounded connection/greeting/socket timeouts — never hangs forever on a dead connection', () => {
    const opts = buildSmtpTransportOptions(STARTTLS_CONFIG);
    expect(opts.connectionTimeout).toBeGreaterThan(0);
    expect(opts.greetingTimeout).toBeGreaterThan(0);
    expect(opts.socketTimeout).toBeGreaterThan(0);
  });
});

describe('describeSmtpConfig — safe for logs', () => {
  it('includes host/port/tlsMode but NEVER username or password', () => {
    const description = describeSmtpConfig(STARTTLS_CONFIG);
    expect(description).toContain('m07.internetmailserver.net');
    expect(description).toContain('587');
    expect(description).toContain('starttls');
    expect(description).not.toContain(REAL_PASSWORD);
    expect(description).not.toContain('marvin@marvinrusinek.com');
  });
});

describe('SmtpEmailSender — successful send', () => {
  it('passes a structured message to sendMail and returns delivered:true with the provider message id', async () => {
    sendMailMock.mockResolvedValue({ messageId: '<abc@m07.internetmailserver.net>' });
    const sender = new SmtpEmailSender({ smtp: STARTTLS_CONFIG, fromAddress: 'certificates@marvinrusinek.com' });

    const result = await sender.send(SAMPLE_MESSAGE);

    expect(result).toEqual({ delivered: true, providerMessageId: '<abc@m07.internetmailserver.net>' });
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const sent = sendMailMock.mock.calls[0][0];
    expect(sent.from).toBe('certificates@marvinrusinek.com');
    expect(sent.to).toBe('claimant@example.com');
    expect(sent.text).toContain('https://example.test/verify#token=abc123');
    expect(sent.html).toContain('https://example.test/verify#token=abc123');
  });

  it('passes the idempotencyKey through as a forensic header only — never as a functional dedup mechanism', async () => {
    sendMailMock.mockResolvedValue({ messageId: '<x@y>' });
    const sender = new SmtpEmailSender({ smtp: STARTTLS_CONFIG, fromAddress: 'certificates@marvinrusinek.com' });
    await sender.send(SAMPLE_MESSAGE);
    const sent = sendMailMock.mock.calls[0][0];
    expect(sent.headers['X-Certificate-Idempotency-Key']).toBe('claimant_verify:cc_1:0');
  });

  it('strips CR/LF from template data before it reaches the message (defense in depth against header/body injection)', async () => {
    sendMailMock.mockResolvedValue({ messageId: '<x@y>' });
    const sender = new SmtpEmailSender({ smtp: STARTTLS_CONFIG, fromAddress: 'certificates@marvinrusinek.com' });
    const malicious: OutboundEmail = {
      ...SAMPLE_MESSAGE,
      templateData: { recipientName: 'Ada\r\nBcc: attacker@evil.test', verificationUrl: 'https://example.test/x' }
    };
    await sender.send(malicious);
    const sent = sendMailMock.mock.calls[0][0];
    expect(sent.text).not.toMatch(/\r\n/);
    expect(sent.html).not.toContain('\r\n');
  });

  it('HTML-escapes template data so it cannot inject markup into the rendered email', async () => {
    sendMailMock.mockResolvedValue({ messageId: '<x@y>' });
    const sender = new SmtpEmailSender({ smtp: STARTTLS_CONFIG, fromAddress: 'certificates@marvinrusinek.com' });
    const malicious: OutboundEmail = {
      ...SAMPLE_MESSAGE,
      templateData: { recipientName: '<script>alert(1)</script>', verificationUrl: 'https://example.test/x' }
    };
    await sender.send(malicious);
    const sent = sendMailMock.mock.calls[0][0];
    expect(sent.html).not.toContain('<script>');
    expect(sent.html).toContain('&lt;script&gt;');
  });

  it('renders the owner_claim_notice kind correctly', async () => {
    sendMailMock.mockResolvedValue({ messageId: '<x@y>' });
    const sender = new SmtpEmailSender({ smtp: STARTTLS_CONFIG, fromAddress: 'certificates@marvinrusinek.com' });
    await sender.send({
      idempotencyKey: 'owner_claim_notice:cert_1:0',
      to: 'owner@marvinrusinek.com',
      kind: 'owner_claim_notice',
      templateData: { claimedName: 'Ada Lovelace', claimedEmail: 'ada@example.com', certificateId: 'AQ-2026-ABC' }
    });
    const sent = sendMailMock.mock.calls[0][0];
    expect(sent.text).toContain('AQ-2026-ABC');
    expect(sent.text).toContain('ada@example.com');
  });
});

describe('SmtpEmailSender — error classification', () => {
  const sender = () => new SmtpEmailSender({ smtp: STARTTLS_CONFIG, fromAddress: 'certificates@marvinrusinek.com' });

  it('authentication failure → SmtpSendError kind "auth"', async () => {
    sendMailMock.mockRejectedValue(Object.assign(new Error('Invalid login'), { code: 'EAUTH' }));
    await expect(sender().send(SAMPLE_MESSAGE)).rejects.toMatchObject({ name: 'SmtpSendError', kind: 'auth' });
  });

  it('connection timeout → SmtpSendError kind "timeout"', async () => {
    sendMailMock.mockRejectedValue(Object.assign(new Error('Connection timed out'), { code: 'ETIMEDOUT' }));
    await expect(sender().send(SAMPLE_MESSAGE)).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('socket-level failure during the TLS handshake → SmtpSendError kind "timeout"', async () => {
    sendMailMock.mockRejectedValue(Object.assign(new Error('socket hang up'), { code: 'ESOCKET' }));
    await expect(sender().send(SAMPLE_MESSAGE)).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('connection refused → SmtpSendError kind "transient"', async () => {
    sendMailMock.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNECTION' }));
    await expect(sender().send(SAMPLE_MESSAGE)).rejects.toMatchObject({ kind: 'transient' });
  });

  it('a 4xx SMTP response (e.g. mailbox temporarily unavailable) → SmtpSendError kind "transient"', async () => {
    sendMailMock.mockRejectedValue(Object.assign(new Error('450 Requested mail action not taken'), { responseCode: 450 }));
    await expect(sender().send(SAMPLE_MESSAGE)).rejects.toMatchObject({ kind: 'transient' });
  });

  it('a 5xx SMTP response (e.g. mailbox does not exist) → SmtpSendError kind "permanent"', async () => {
    sendMailMock.mockRejectedValue(Object.assign(new Error('550 No such user'), { responseCode: 550 }));
    await expect(sender().send(SAMPLE_MESSAGE)).rejects.toMatchObject({ kind: 'permanent' });
  });

  it('an unrecognized error shape still throws a classified SmtpSendError (kind "unknown"), never crashes uncaught', async () => {
    sendMailMock.mockRejectedValue(new Error('something unexpected'));
    await expect(sender().send(SAMPLE_MESSAGE)).rejects.toBeInstanceOf(SmtpSendError);
    await expect(sender().send(SAMPLE_MESSAGE)).rejects.toMatchObject({ kind: 'unknown' });
  });

  it('every thrown SmtpSendError is an instance of Error (so it is caught correctly by the dispatcher\'s own try/catch)', async () => {
    sendMailMock.mockRejectedValue(Object.assign(new Error('Invalid login'), { code: 'EAUTH' }));
    await expect(sender().send(SAMPLE_MESSAGE)).rejects.toBeInstanceOf(Error);
  });
});

describe('SmtpEmailSender — secret redaction', () => {
  it('no thrown error, for ANY failure kind, ever contains the configured password', async () => {
    const scenarios: Array<Record<string, unknown>> = [
      { code: 'EAUTH' },
      { code: 'ETIMEDOUT' },
      { code: 'ECONNECTION' },
      { responseCode: 450 },
      { responseCode: 550 },
      {}
    ];
    for (const extra of scenarios) {
      sendMailMock.mockRejectedValueOnce(Object.assign(new Error(`failure containing nothing secret`), extra));
      try {
        await sender_().send(SAMPLE_MESSAGE);
        throw new Error('expected send() to throw');
      } catch (err: unknown) {
        expect((err as Error).message).not.toContain(REAL_PASSWORD);
      }
    }
    function sender_(): SmtpEmailSender {
      return new SmtpEmailSender({ smtp: STARTTLS_CONFIG, fromAddress: 'certificates@marvinrusinek.com' });
    }
  });

  it('successful-send console-visible fields (providerMessageId) never echo the password either', async () => {
    sendMailMock.mockResolvedValue({ messageId: '<real-id@m07.internetmailserver.net>' });
    const sender = new SmtpEmailSender({ smtp: STARTTLS_CONFIG, fromAddress: 'certificates@marvinrusinek.com' });
    const result = await sender.send(SAMPLE_MESSAGE);
    expect(JSON.stringify(result)).not.toContain(REAL_PASSWORD);
  });
});
