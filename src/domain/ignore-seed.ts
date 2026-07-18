// Seed ignore list — sender ADDRESS domains whose mail is never posting/pricing
// (D6). Merged with user/AI-added `ignore` docs at check time. These are big
// automated senders (social, platforms, notifications) that only generate noise.

/** Bare sender-address domains to always ignore. Normalized (lowercase, no www). */
export const IGNORE_SEED_DOMAINS: readonly string[] = [
  'google.com',
  'accounts.google.com',
  'mail.google.com',
  'facebook.com',
  'facebookmail.com',
  'instagram.com',
  'mail.instagram.com',
  'linkedin.com',
  'twitter.com',
  'x.com',
  'youtube.com',
  'notifications.google.com',
  'noreply.youtube.com',
  'tiktok.com',
  'pinterest.com',
  'reddit.com',
  'quora.com',
  'medium.com',
  'slack.com',
  'trello.com',
  'notion.so',
  'dropbox.com',
];

const SEED_SET = new Set(IGNORE_SEED_DOMAINS);

/** True when a bare (already-normalized) sender-address domain is seed-ignored. */
export function isSeedIgnoredDomain(domain: string): boolean {
  return SEED_SET.has(domain);
}
