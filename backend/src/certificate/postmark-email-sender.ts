import type { CertificatePostmarkConfig } from '../config';
import type { EmailSender, EmailSendErrorKind, EmailSendResult, OutboundEmail } from './email-sender';
import { renderEmail } from './email-render';

/**
 * Production email delivery via Postmark's HTTP Email API — an alternative
 * to smtp-email-sender.ts, selectable via CERTIFICATE_EMAIL_PROVIDER=
 * postmark. Kept alongside the SMTP adapter deliberately: the production
 * Node service runs on Render's free tier, which blocks outbound SMTP
 * ports entirely (confirmed directly from Render's own changelog — see
 * docs/certificate-claims-runbook.md) but does NOT block ordinary outbound
 * HTTPS, which is all this adapter uses.
 *
 * Checked directly against Postmark's own docs
 * (https://postmarkapp.com/developer/api/email-api,
 * https://postmarkapp.com/developer/api/overview), not assumed:
 *   - endpoint: POST https://api.postmarkapp.com/email
 *   - auth: X-Postmark-Server-Token header — a SERVER token, never an
 *     account token (the two are explicitly distinct in Postmark's own
 *     docs; an account token has broader privileges than sending mail
 *     needs, so this module has no field for one at all);
 *   - success response: {To, SubmittedAt, MessageID, ErrorCode: 0,
 *     Message: "OK"};
 *   - error response: {ErrorCode, Message}, also echoed in the
 *     X-PM-ApiErrorCode response header.
 *
 * POSTMARK DOCUMENTS NO IDEMPOTENCY KEY, DEDUPLICATION MECHANISM, OR
 * RETRY-SAFETY GUARANTEE OF ANY KIND for repeated requests — checked
 * directly, not assumed (its API overview's error-handling section covers
 * auth, rate limits and error codes, and says nothing about replaying a
 * request safely). This puts Postmark in exactly the same position as the
 * SMTP adapter it sits alongside: `idempotencyKey` below is sent as a
 * forensic `X-Certificate-Idempotency-Key` custom header for log
 * correlation only, and MUST NOT be assumed to prevent a duplicate send.
 * The byte-identical encrypted retry payload (see certificate-outbox-
 * crypto.ts) is preserved for the same narrower reason as the SMTP
 * adapter: a stable verification link across retries, not deduplication.
 * See email-sender.ts's own top doc comment for the full, honest statement
 * of what this design can and cannot guarantee, shared across both
 * providers. A 2xx response with ErrorCode 0 means Postmark ACCEPTED the
 * message for delivery — it is not proof the message reached an inbox.
 */

const POSTMARK_API_URL = 'https://api.postmarkapp.com/email';
const REQUEST_TIMEOUT_MS = 15_000;

export type PostmarkSendErrorKind = EmailSendErrorKind;

/**
 * Classified Postmark failure. `kind` is derived from the HTTP status and,
 * where present, Postmark's own numeric ErrorCode (full reference:
 * https://postmarkapp.com/developer/api/overview#error-codes) — see
 * classifyPostmarkFailure below. The dispatcher does not currently branch
 * on `kind` (every failure still follows the same bounded-retry schedule —
 * see certificate-notification-dispatcher.ts), but the classification is
 * visible in logs and assertable in tests, matching SmtpSendError's role
 * for the other provider.
 */
export class PostmarkSendError extends Error {
  public override readonly name = 'PostmarkSendError';
  public readonly kind: PostmarkSendErrorKind;

  constructor(kind: PostmarkSendErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

/**
 * ErrorCodes that mean "this exact request will never succeed by itself" —
 * a sender-signature/domain problem, an account restriction, a malformed
 * field, or a suppressed recipient (see §"setup checklist" in the runbook
 * for why 412/413/406 matter operationally: Postmark account approval,
 * sending limits, and suppression are real, expected early states, not
 * bugs). Retrying the identical payload will not change any of these.
 */
const PERMANENT_POSTMARK_ERROR_CODES = new Set([
  300, // Invalid email request
  400, // Sender Signature not found
  401, // Sender signature not confirmed
  402, // Invalid JSON
  403, // Incompatible JSON
  405, // Not allowed to send
  406, // Inactive recipient (suppressed — hard bounce / spam complaint / manual)
  409, // JSON required
  411, // Forbidden attachment type
  412, // Account is Pending (approval not yet complete)
  413, // Account May Not Send (suspended / over limit)
  511, // Invalid fields supplied
  1221, // Invalid MessageStreamType
  1235, // MessageStream does not exist on this server
  1236 // Sending not supported on the supplied MessageStream
]);

interface PostmarkSuccessBody {
  readonly To: string;
  readonly SubmittedAt: string;
  readonly MessageID: string;
  readonly ErrorCode: 0;
  readonly Message: string;
}

interface PostmarkErrorBody {
  readonly ErrorCode: number;
  readonly Message: string;
}

function classifyPostmarkFailure(status: number, errorCode: number | undefined): PostmarkSendErrorKind {
  if (status === 401 || errorCode === 10) return 'auth';
  if (status === 429 || errorCode === 429) return 'transient';
  if (status >= 500) return 'transient';
  if (errorCode === 100) return 'transient'; // Maintenance
  if (errorCode !== undefined && PERMANENT_POSTMARK_ERROR_CODES.has(errorCode)) return 'permanent';
  if (status === 422 || status === 400 || status === 403 || status === 404 || status === 413 || status === 415) return 'permanent';
  return 'unknown';
}

/** Server token only — see this module's own top doc comment. Never logged. */
export function describePostmarkConfig(config: CertificatePostmarkConfig): string {
  return `message stream "${config.messageStream}"`;
}

export interface PostmarkEmailSenderOptions {
  readonly postmark: CertificatePostmarkConfig;
  readonly fromAddress: string;
}

export class PostmarkEmailSender implements EmailSender {
  private readonly serverToken: string;
  private readonly messageStream: string;
  private readonly fromAddress: string;

  constructor(options: PostmarkEmailSenderOptions) {
    this.serverToken = options.postmark.serverToken;
    this.messageStream = options.postmark.messageStream;
    this.fromAddress = options.fromAddress;
  }

  async send(message: OutboundEmail): Promise<EmailSendResult> {
    const { subject, text, html } = renderEmail(message);

    const body = {
      From: this.fromAddress,
      To: message.to,
      Subject: subject,
      TextBody: text,
      HtmlBody: html,
      MessageStream: this.messageStream,
      // Explicitly disabled, not merely left at a default — a transactional
      // certificate-verification link has no legitimate reason to carry
      // open/click tracking.
      TrackOpens: false,
      TrackLinks: 'None',
      Headers: [
        // Forensic correlation only — see this module's own top doc
        // comment for why this is NOT functional deduplication.
        { Name: 'X-Certificate-Idempotency-Key', Value: message.idempotencyKey }
      ]
    };

    let response: Response;
    try {
      response = await fetch(POSTMARK_API_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Postmark-Server-Token': this.serverToken
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch (err: unknown) {
      // A network-level failure: DNS, connection refused, or our own
      // AbortSignal firing. Never includes the server token — fetch's own
      // error never carries request headers, only connection-level detail.
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new PostmarkSendError('timeout', `Postmark request timed out after ${REQUEST_TIMEOUT_MS}ms`);
      }
      const message_ = err instanceof Error ? err.message : String(err);
      throw new PostmarkSendError('transient', `Postmark request failed: ${message_}`);
    }

    // Read the body ONCE as text, then attempt to parse — a malformed/non-
    // JSON error response (e.g. an upstream proxy's own HTML error page)
    // must not throw an unclassified SyntaxError past this boundary.
    const rawBody = await response.text();
    let parsed: PostmarkSuccessBody | PostmarkErrorBody | null = null;
    try {
      parsed = JSON.parse(rawBody) as PostmarkSuccessBody | PostmarkErrorBody;
    } catch {
      parsed = null;
    }

    if (response.ok && parsed && 'ErrorCode' in parsed && parsed.ErrorCode === 0) {
      const success = parsed as PostmarkSuccessBody;
      return { delivered: true, providerMessageId: success.MessageID };
    }

    const errorCode = parsed && 'ErrorCode' in parsed ? parsed.ErrorCode : undefined;
    const providerMessage = parsed?.Message ?? '(no JSON body)';
    const kind = classifyPostmarkFailure(response.status, errorCode);
    throw new PostmarkSendError(
      kind,
      `Postmark send failed (HTTP ${response.status}${errorCode !== undefined ? `, ErrorCode ${errorCode}` : ''}): ${providerMessage}`
    );
  }
}
