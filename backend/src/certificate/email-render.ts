import type { ClaimantVerifyTemplateData, OutboundEmail, OwnerClaimNoticeTemplateData } from './email-sender';

/**
 * Shared rendering for every concrete EmailSender — SMTP and Postmark
 * (and any future provider) render IDENTICAL subject/text/html for the
 * same OutboundEmail, from this one implementation, so the two providers
 * can never silently drift into different wording.
 */

/** Strips header-injection-relevant control characters — defense in depth; see email-sender.ts's own doc comment for why structured fields are the actual elimination of the vulnerability class. */
export function stripControlChars(value: string): string {
  return value.replace(/[\r\n\0]/g, '');
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderEmail(message: OutboundEmail): { readonly subject: string; readonly text: string; readonly html: string } {
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
