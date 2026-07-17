// Deterministic, template-based email drafter (no LLM). Renders from
// senderName + advertised + format/topic + greeting, and always asks one broad
// pricing question (regular / link insertion / grey niches). Pure.
// (Optional LLM personalization of a single opening line is a later add-on.)

import type { Account, PitchProfile, Target } from '../domain/types';

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

export function draftEmail(profile: PitchProfile, account: Account, target: Target): DraftedEmail {
  const greeting = target.contactName?.trim() || siteName(target.websiteUrl);
  const subject =
    profile.subjectTemplate?.trim() ||
    `Interest in publishing a post about ${indefinite(profile.topic)} on your website`;

  const sig = account.signature?.trim() || `Best regards,\n${account.senderName}`;
  const hook = target.notes?.trim() ? `\n${target.notes.trim()}\n` : '';

  const manageLine = profile.advertised.description
    ? `My name is ${account.senderName} and I manage ${profile.advertised.description} - ${profile.advertised.url}.`
    : `My name is ${account.senderName} and I represent ${profile.advertised.url}.`;

  // One broad ask that surfaces every price we care about, whatever the pitch
  // topic — regular content, link insertions, and grey/sensitive niches.
  const questions = [
    '  - A regular guest post / sponsored article',
    '  - A link insertion (adding a link into an existing article)',
    '  - Gray / sensitive niches — please specify casino and VPN separately if their rates differ',
  ].join('\n');

  const topicClause = profile.topic ? ` about ${profile.topic}` : '';
  const inquiryLine =
    `I'm writing to inquire about the possibility of publishing ${indefinite(profile.format)}${topicClause} on your website. ` +
    `Could you please share your rates for:\n\n${questions}`;

  const body = [
    `Hello, ${greeting},`,
    '',
    manageLine,
    '',
    inquiryLine,
    hook,
    'Thank you in advance for your time and response!',
    '',
    sig,
  ].join('\n');

  return { subject, body };
}
