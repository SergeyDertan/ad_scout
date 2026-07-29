// Deterministic, template-based email drafter (no LLM). Renders a broad,
// agency-style pitch that does NOT name any advertised site or single topic — it
// simply asks the publisher for their guest-post rate card (regular / grey
// niches). Only the sender name and the target greeting are personalized. This is
// the standard message for every batch going forward. Pure.

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

export function draftEmail(profile: PitchProfile, account: Account, target: Target): DraftedEmail {
  const greeting = target.contactName?.trim() || siteName(target.websiteUrl);
  const subject =
    profile.subjectTemplate?.trim() || 'Interest in publishing a sponsored post on your website';

  const sig = account.signature?.trim() || `Best regards,\n${account.senderName}`;
  const hook = target.notes?.trim() ? `\n${target.notes.trim()}\n` : '';

  // Generic manager framing — no advertised site, no single niche. We're gathering
  // rate cards, so the ask is broad and the same for everyone.
  const introLine =
    `My name is ${account.senderName}, and I'm an advertising manager who helps brands ` +
    'get featured through sponsored posts on quality websites like yours.';

  // One broad ask covering every price we care about. Guest posts only — we don't
  // buy link insertions or banners, so we never invite a quote for them.
  const questions = [
    '  - A regular guest post / sponsored article',
    '  - Gray / sensitive niches — please specify casino and VPN separately if their rates differ',
  ].join('\n');

  const inquiryLine =
    'I\'d like to know whether you accept paid publications — and if so, could you please ' +
    `share your guest-post rates for:\n\n${questions}`;

  const body = [
    `Hello, ${greeting},`,
    '',
    introLine,
    '',
    inquiryLine,
    hook,
    'Thank you in advance for your time and response!',
    '',
    sig,
  ].join('\n');

  return { subject, body };
}
