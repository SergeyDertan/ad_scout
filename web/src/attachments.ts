// Turning what a person dropped, pasted or picked into what the API takes.
//
// The caps are stated here as well as on the server, and that duplication is
// deliberate: the server is the one that ENFORCES them (a browser is not a place
// to enforce anything), while these exist so an 8 MB file is refused instantly,
// against the file the person can still see, rather than after a slow upload of
// something that was never going to send. They must match
// src/ports/email-provider.ts.

import type { EmailAttachment } from './types';

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 3.5 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Why this file cannot join the ones already staged, or undefined if it can.
 *
 * Returns the sentence to show rather than a boolean: "too big" is useless
 * without which file and what the limit was, and this is the only place that
 * knows both.
 */
export function rejectReason(
  staged: EmailAttachment[],
  file: { name: string; size: number },
): string | undefined {
  if (staged.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
    return `One message can carry ${MAX_ATTACHMENTS_PER_MESSAGE} files at most.`;
  }
  if (file.size <= 0) return `${file.name} is empty.`;
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return `${file.name} is ${fmtSize(file.size)} — the limit for one file is ${fmtSize(MAX_ATTACHMENT_BYTES)}.`;
  }
  const total = staged.reduce((sum, a) => sum + a.size, 0) + file.size;
  if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
    return `Adding ${file.name} takes this message over ${fmtSize(MAX_TOTAL_ATTACHMENT_BYTES)}, which is more than one email can carry.`;
  }
  return undefined;
}

/**
 * A picked File as the API's attachment shape.
 *
 * readAsDataURL rather than readAsArrayBuffer + manual encoding: it hands back
 * canonical base64 that the server re-encodes to the identical string, and it
 * avoids building a second copy of the bytes in JS.
 *
 * The name is taken as given. A pasted screenshot arrives called "image.png" —
 * every one of them does — but only the caller knows a paste from a pick, so
 * renaming is its job (see pastedName).
 */
export function readAsAttachment(file: File): Promise<EmailAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.onload = () => {
      const url = String(reader.result ?? '');
      const comma = url.indexOf(',');
      if (comma < 0) return reject(new Error(`Could not read ${file.name}`));
      resolve({
        filename: file.name,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
        contentBase64: url.slice(comma + 1),
      });
    };
    reader.readAsDataURL(file);
  });
}

/**
 * The name a pasted screenshot should carry.
 *
 * The clipboard calls every screenshot "image.png", so three pastes in one
 * message would otherwise be three identically named attachments — unreadable
 * in the publisher's client and in ours. A file someone deliberately chose
 * keeps its own name, even if that name is image.png.
 */
export function pastedName(mimeType: string, at: Date): string {
  const ext = mimeType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png';
  const stamp = at.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `screenshot-${stamp}.${ext}`;
}
