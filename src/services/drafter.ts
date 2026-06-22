// Deterministic, template-based email drafter (no LLM). Renders from
// senderName + advertised + format/topic + inquiryFields + greeting. Pure.
// (Optional LLM personalization of a single opening line is a later add-on.)

import type { Account, Campaign, Target } from '../domain/types';

export interface DraftedEmail {
  subject: string;
  body: string;
}

/** Domain-ish display name from a website URL (fallback greeting). */
export function siteName(url: string): string {
  return url
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/.*$/, '')
    .trim();
}

function indefinite(word: string): string {
  return /^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`;
}

export function draftEmail(campaign: Campaign, account: Account, target: Target): DraftedEmail {
  const greeting = target.contactName?.trim() || siteName(target.websiteUrl);
  const subject =
    campaign.subjectTemplate?.trim() ||
    `Interest in publishing a post about ${indefinite(campaign.topic)} on your website`;

  const questions = campaign.inquiryFields.map((f) => `  - ${f.question}`).join('\n');
  const sig = account.signature?.trim() || `Best regards,\n${account.senderName}`;
  const hook = target.notes?.trim() ? `\n${target.notes.trim()}\n` : '';

  const body = [
    `Hello, ${greeting},`,
    '',
    `My name is ${account.senderName} and I manage ${campaign.advertised.description} — ${campaign.advertised.url}.`,
    '',
    `I'm writing to inquire about the possibility of publishing ${indefinite(campaign.format)} about ${campaign.topic} on your website. Could you please confirm the following:`,
    '',
    questions,
    hook,
    'Thank you in advance for your time and response!',
    '',
    sig,
  ].join('\n');

  return { subject, body };
}
