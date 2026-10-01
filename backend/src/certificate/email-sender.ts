/**
 * The email-sending boundary. Every concrete provider (or the in-memory
 * fake used locally and in every test) implements this ONE interface, so
 * the rest of the certificate-claim feature never knows which provider is
 * behind it.
 *
 * STRUCTURED FIELDS ONLY, deliberately: nothing here ever builds a raw
 * SMTP/header string by concatenation. `to` and `templateData` are passed
 * to whatever the real provider's SDK exposes as structured parameters —
 * this is what makes header injection structurally impossible at this
 * layer, not merely filtered. (A concrete provider implementation should
 * additionally strip CR/LF from every templateData value as defense in
 * depth, but the actual elimination of the vulnerability CLASS comes from
 * never touching a raw header string in the first place.)
 *
 * IDEMPOTENCY: `idempotencyKey` is stable for the lifetime of one outbox
 * row's CURRENT generation (see certificate-notification-dispatcher.ts) —
 * every attempt to send that same row/generation reuses the same key AND,
 * for claimant_verify, the SAME rendered payload. This was ORIGINALLY
 * designed around Resend's HTTP API, whose idempotency-key contract
 * (checked directly against its docs, not assumed) returns the ORIGINAL
 * result for a repeated key only when the request body also matches.
 * NEITHER OF THE TWO IMPLEMENTED PROVIDERS SHARES THAT GUARANTEE — checked
 * directly against each one's own docs, not assumed:
 *   - SMTP (smtp-email-sender.ts, Nodemailer): plain SMTP has no
 *     idempotency concept at all. Once a message is accepted, there is no
 *     way to ask the server later whether a retry is "the same request."
 *   - Postmark (postmark-email-sender.ts): its HTTP Email API docs
 *     document no idempotency key, deduplication mechanism, or retry-
 *     safety guarantee of any kind for repeated requests.
 * `idempotencyKey` is still passed to both as a forensic trace header
 * only, never functional dedup, and the byte-identical-payload mechanism
 * is still preserved for its OTHER benefit — a stable verification link
 * across retries — regardless of which provider is selected. See each
 * sender's own doc comment for the honest, undiluted statement of what
 * this design can and cannot guarantee: a crash between the provider
 * accepting a message and this process recording that fact CAN still
 * produce a duplicate physical email, with either provider. Exactly-once
 * delivery is never claimed. Provider ACCEPTANCE is also never proof of
 * actual INBOX delivery — a provider's own result only means it took
 * responsibility for the message, not that it reached the recipient.
 */

/**
 * Shared classification vocabulary across every concrete EmailSender —
 * both SmtpSendError and PostmarkSendError use this same set, so a caller
 * (or a log line) never has to know which provider is behind an error to
 * make sense of its `kind`.
 */
export type EmailSendErrorKind = 'auth' | 'timeout' | 'transient' | 'permanent' | 'unknown';

export type CertificateNotificationKind = 'claimant_verify' | 'owner_claim_notice';

/** Structured data for the claimant's own verification email. */
export interface ClaimantVerifyTemplateData {
  readonly recipientName: string;
  /** Same-origin Angular route carrying the raw token in a URL FRAGMENT, never a query string — see certificate-claim.service.ts. */
  readonly verificationUrl: string;
}

/** Structured data for Marvin's owner-completion notice. */
export interface OwnerClaimNoticeTemplateData {
  readonly claimedName: string;
  readonly claimedEmail: string;
  readonly certificateId: string;
}

export interface OutboundEmail {
  /** Stable per outbox row — see the doc comment above. */
  readonly idempotencyKey: string;
  readonly to: string;
  readonly kind: CertificateNotificationKind;
  readonly templateData: ClaimantVerifyTemplateData | OwnerClaimNoticeTemplateData;
}

export interface EmailSendResult {
  /** The provider ACCEPTED the send request. Never a guarantee of inbox delivery. */
  readonly delivered: boolean;
  readonly providerMessageId?: string;
}

export interface EmailSender {
  send(message: OutboundEmail): Promise<EmailSendResult>;
}

/**
 * In-memory fake for local development and every test. Sends NOTHING
 * anywhere. Deliberately does not console.log anything by default — a
 * message's `to`/templateData (a real or test email address, and whatever
 * link it carries) is exactly the content this feature exists to keep out
 * of logs, so the "safe to run locally with no provider" default must not
 * quietly reintroduce that leak through stdout instead of a real send.
 *
 * Simulates provider-level idempotency (see the interface doc comment
 * above): a second `send()` call with an ALREADY-SEEN idempotencyKey
 * returns the original result without appending to `sentMessages` again —
 * this is what lets a test prove "two attempts, one actual delivery." This
 * is DELIBERATELY more generous than the real, implemented SmtpEmailSender
 * (which has no such behavior at all — see its own doc comment): it
 * exists so the outbox/dispatcher mechanism's OWN correctness (exactly one
 * row, correct generation handling, correct backoff) stays testable in
 * isolation from provider-specific limitations, not to imply SMTP shares
 * this property.
 */
export class InMemoryEmailSender implements EmailSender {
  /** Test inspection only. Never logged. */
  public readonly sentMessages: OutboundEmail[] = [];

  private readonly resultsByIdempotencyKey = new Map<string, EmailSendResult>();
  private pendingFailures = 0;

  async send(message: OutboundEmail): Promise<EmailSendResult> {
    const existing = this.resultsByIdempotencyKey.get(message.idempotencyKey);
    if (existing) return existing;

    if (this.pendingFailures > 0) {
      this.pendingFailures -= 1;
      throw new Error('InMemoryEmailSender: simulated provider failure');
    }

    const result: EmailSendResult = {
      delivered: true,
      providerMessageId: `fake_${message.idempotencyKey}`
    };
    this.resultsByIdempotencyKey.set(message.idempotencyKey, result);
    this.sentMessages.push(message);
    return result;
  }

  /** Test hook: the next N send() calls throw instead of succeeding. */
  failNextSends(count: number): void {
    this.pendingFailures = count;
  }

  /** Test hook: how many times THIS exact idempotency key actually reached send(). */
  deliveryCountFor(idempotencyKey: string): number {
    return this.sentMessages.filter((m) => m.idempotencyKey === idempotencyKey).length;
  }

  reset(): void {
    this.sentMessages.length = 0;
    this.resultsByIdempotencyKey.clear();
    this.pendingFailures = 0;
  }
}
