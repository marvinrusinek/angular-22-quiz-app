import nodemailer, { type Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';

import type { CertificateSmtpConfig } from '../config';
import type { ClaimantVerifyTemplateData, EmailSender, EmailSendResult, OutboundEmail, OwnerClaimNoticeTemplateData } from './email-sender';

/**
 * Production email delivery via authenticated SMTP (Nodemailer). Built for
 * Winhost's mail service (confirmed via this domain's own MX record and a
 * direct STARTTLS handshake against it), but nothing here is Winhost-
 * specific — any standards-compliant SMTP submission server works the same
 * way.
 *
 * SMTP GIVES NO IDEMPOTENCY GUARANTEE. This is a real, honest difference
 * from the originally-intended Resend adapter (see certificate-
 * notification-dispatcher.ts's own doc comment for the full design this
 * drives): a provider-side Idempotency-Key header is an HTTP-API concept
 * with no SMTP equivalent. Once an SMTP server returns `250 OK` for a
 * message, there is no way to later ask it "did you already get this" — a
 * retry is just another ordinary send. The `idempotencyKey` field on
 * OutboundEmail is still passed through, as a custom `X-Certificate-
 * Idempotency-Key` header, purely for FORENSIC traceability (so a
 * duplicate delivery can be correlated back to one outbox row/generation
 * in the logs) — it provides NO functional deduplication here, unlike the
 * Resend design it was originally built for.
 *
 * THE RESIDUAL RISK THIS CANNOT ELIMINATE: if this process crashes after
 * the SMTP server accepts a message (returns `250 OK`) but before
 * markNotificationSent's UPDATE persists that fact, the next retry WILL
 * send a second, genuinely duplicate physical email. The byte-identical
 * retry payload (encrypted and persisted before send — still preserved
 * here, see certificate-outbox-crypto.ts) keeps that duplicate's CONTENT
 * identical and keeps the verification link stable across retries, but it
 * does not and cannot prevent the duplicate SEND itself over plain SMTP.
 * This system still guarantees exactly one outbox ROW, exactly one
 * certificate, and exactly one owner-notification ROW — it does NOT
 * guarantee exactly one email reaches an inbox. That claim is never made.
 */

const CONNECTION_TIMEOUT_MS = 10_000;
const GREETING_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 20_000;

/**
 * Pure and directly testable, separate from the class below, specifically
 * so a test can assert the exact security-relevant transport options
 * (requireTLS, secure, rejectUnauthorized, minVersion) without needing a
 * live SMTP connection.
 *
 * CERTIFICATE VALIDATION IS NEVER CONFIGURABLE: `rejectUnauthorized: true`
 * and a TLS 1.2 floor are hard-coded here, not read from any env var or
 * config field — there is no way to construct a transport that skips
 * either. `requireTLS: true` only applies to 'starttls' mode (mandatory
 * STARTTLS upgrade — the connection fails rather than falling back to
 * plaintext if the server doesn't offer it); 'tls' mode uses `secure: true`
 * instead (implicit TLS from the first byte, conventionally port 465).
 */
export function buildSmtpTransportOptions(config: CertificateSmtpConfig): SMTPTransport.Options {
  return {
    host: config.host,
    port: config.port,
    secure: config.tlsMode === 'tls',
    requireTLS: config.tlsMode === 'starttls',
    auth: { user: config.username, pass: config.password },
    tls: {
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2'
    },
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS
  };
}

/** Host/port/tlsMode only — never username or password. Safe for startup logs. */
export function describeSmtpConfig(config: CertificateSmtpConfig): string {
  return `${config.host}:${config.port} (${config.tlsMode})`;
}

export type SmtpSendErrorKind = 'auth' | 'timeout' | 'transient' | 'permanent' | 'unknown';

/**
 * Classified SMTP failure. `kind` is derived from Nodemailer's own error
 * `code` and, where present, the raw SMTP response code (4xx = transient,
 * per-attempt retryable; 5xx = permanent, e.g. a rejected recipient) — see
 * toSmtpSendError below. The dispatcher does not currently branch on
 * `kind` (every failure still follows the same bounded-retry schedule —
 * see certificate-notification-dispatcher.ts), but the classification is
 * surfaced on the error itself so it is visible in logs and assertable in
 * tests, and so a future change CAN branch on it without re-deriving this
 * logic.
 */
export class SmtpSendError extends Error {
  public override readonly name = 'SmtpSendError';
  public readonly kind: SmtpSendErrorKind;

  constructor(kind: SmtpSendErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

/**
 * Maps a Nodemailer/SMTP failure to a classified SmtpSendError. Never
 * includes the configured username or password — Nodemailer's own errors
 * do not echo the password back (confirmed by inspecting its auth
 * implementation), and this function adds nothing of its own from the
 * config, only the underlying error's own message (server-authored SMTP
 * response text, or a Node socket-layer error string — neither secret).
 */
function toSmtpSendError(err: unknown): SmtpSendError {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  const responseCode = typeof err === 'object' && err !== null ? (err as { responseCode?: unknown }).responseCode : undefined;
  const message = err instanceof Error ? err.message : String(err);

  if (code === 'EAUTH') return new SmtpSendError('auth', `SMTP authentication failed: ${message}`);
  if (code === 'ETIMEDOUT' || code === 'ESOCKET') return new SmtpSendError('timeout', `SMTP connection timed out: ${message}`);
  if (code === 'ECONNECTION' || code === 'EDNS') return new SmtpSendError('transient', `SMTP connection failed: ${message}`);
  if (typeof responseCode === 'number') {
    if (responseCode >= 400 && responseCode < 500) return new SmtpSendError('transient', `SMTP server returned a transient error (${responseCode}): ${message}`);
    if (responseCode >= 500) return new SmtpSendError('permanent', `SMTP server returned a permanent error (${responseCode}): ${message}`);
  }
  return new SmtpSendError('unknown', `SMTP send failed: ${message}`);
}

/** Strips header-injection-relevant control characters — defense in depth; see email-sender.ts's own doc comment for why structured fields are the actual elimination of the vulnerability class. */
function stripControlChars(value: string): string {
  return value.replace(/[\r\n\0]/g, '');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderEmail(message: OutboundEmail): { readonly subject: string; readonly text: string; readonly html: string } {
  if (message.kind === 'claimant_verify') {
    const data = message.templateData as ClaimantVerifyTemplateData;
    const name = stripControlChars(data.recipientName);
    const url = stripControlChars(data.verificationUrl);
    return {
      subject: 'Confirm your Angular Interview Master certificate',
      text:
        `Hi ${name},\n\n` +
        `Confirm your Angular Interview Master certificate by opening this link:\n${url}\n\n` +
        'This confirms you control this email address. Your name and email will be shared ' +
        "with the app owner once confirmed. If you didn't request this, you can ignore this email.",
      html:
        `<p>Hi ${escapeHtml(name)},</p>` +
        `<p>Confirm your Angular Interview Master certificate by opening this link:</p>` +
        `<p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>` +
        '<p>This confirms you control this email address. Your name and email will be shared ' +
        "with the app owner once confirmed. If you didn't request this, you can ignore this email.</p>"
    };
  }

  const data = message.templateData as OwnerClaimNoticeTemplateData;
  const claimedName = stripControlChars(data.claimedName);
  const claimedEmail = stripControlChars(data.claimedEmail);
  const certificateId = stripControlChars(data.certificateId);
  return {
    subject: `Certificate issued: ${certificateId}`,
    text: `A certificate was issued.\n\nName: ${claimedName}\nEmail: ${claimedEmail}\nCertificate ID: ${certificateId}`,
    html:
      '<p>A certificate was issued.</p>' +
      `<ul><li>Name: ${escapeHtml(claimedName)}</li>` +
      `<li>Email: ${escapeHtml(claimedEmail)}</li>` +
      `<li>Certificate ID: ${escapeHtml(certificateId)}</li></ul>`
  };
}

export interface SmtpEmailSenderOptions {
  readonly smtp: CertificateSmtpConfig;
  readonly fromAddress: string;
}

export class SmtpEmailSender implements EmailSender {
  private readonly transporter: Transporter;
  private readonly fromAddress: string;

  constructor(options: SmtpEmailSenderOptions) {
    this.fromAddress = options.fromAddress;
    this.transporter = nodemailer.createTransport(buildSmtpTransportOptions(options.smtp));
  }

  async send(message: OutboundEmail): Promise<EmailSendResult> {
    const { subject, text, html } = renderEmail(message);
    try {
      const info = await this.transporter.sendMail({
        from: this.fromAddress,
        to: message.to,
        subject,
        text,
        html,
        headers: {
          // Forensic correlation only — see this module's own top doc
          // comment for why this is NOT functional deduplication over SMTP.
          'X-Certificate-Idempotency-Key': message.idempotencyKey
        }
      });
      return { delivered: true, providerMessageId: info.messageId };
    } catch (err: unknown) {
      throw toSmtpSendError(err);
    }
  }
}
