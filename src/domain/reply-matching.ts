// Pure reply-matching + bounce detection (overview.md §4). No I/O.
// Match order: threadId  →  exact fromAddress (awaiting targets)  →  unmatched.
// We NEVER parse Re:/References headers — the server already computed threading.

import { normalizeDomain } from './domain';
import type { MatchMethod, PostOffer, Target } from './types';

export interface SentOutreachRef {
  targetId: string;
  threadId?: string;
}

export interface AwaitingTargetRef {
  targetId: string;
  contactEmail: string;
}

export interface IncomingRef {
  threadId?: string;
  fromAddress: string;
}

export interface MatchResult {
  targetId?: string;
  method: MatchMethod;
}

// A bare address, no wrapping punctuation. Deliberately conservative: this is
// only used to peel an address back out of noise (markdown `[x](mailto:x)`,
// display-name `Foo <x>`), never to validate.
const BARE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

export function normalizeEmail(addr: string): string {
  const trimmed = addr.trim().toLowerCase();
  // Peel the bare address out of `[x@y](mailto:x@y)`, `<x@y>`, `Foo <x@y>` etc.
  // A clean address matches itself, so this is a no-op on well-formed input.
  const m = trimmed.match(BARE_EMAIL);
  return m ? m[0] : trimmed;
}

/**
 * Mailbox providers whose domain says NOTHING about the sender's website. A
 * publisher writing from info@theirsite.com is telling us which site they mean;
 * one writing from the same person's gmail is not.
 *
 * This is the hinge for an unmatched reply. With a real domain we can anchor a
 * bulk price list to the sender's own site (MAX_DOMAINS_PER_REPLY keeps that one
 * row). From a free mailbox there is nothing to anchor to, so the same cap drops
 * everything — which is the intended outcome: a 900-row rate card from a gmail
 * address tells us nothing attributable.
 *
 * Not exhaustive and never will be; it is a denylist of the providers that
 * actually show up. A missing entry degrades safely — the worst case is that we
 * attribute a bulk list to a mailbox domain, which then surfaces for review.
 */
export const FREEMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'outlook.co.uk', 'hotmail.com',
  'hotmail.co.uk', 'hotmail.fr', 'hotmail.it', 'hotmail.es', 'live.com',
  'live.co.uk', 'msn.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.co.in',
  'yahoo.fr', 'yahoo.de', 'yahoo.es', 'yahoo.it', 'ymail.com', 'rocketmail.com',
  'aol.com', 'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com',
  'pm.me', 'gmx.com', 'gmx.de', 'gmx.net', 'web.de', 'mail.com', 'mail.ru',
  'inbox.ru', 'bk.ru', 'list.ru', 'internet.ru', 'yandex.ru', 'yandex.com',
  'ya.ru', 'ukr.net', 'i.ua', 'meta.ua', 'zoho.com', 'fastmail.com',
  'tutanota.com', 'tuta.io', 'hushmail.com', 'qq.com', '163.com', '126.com',
  'sina.com', 'naver.com', 'daum.net', 'hanmail.net', 'seznam.cz', 'wp.pl',
  'o2.pl', 'onet.pl', 'interia.pl', 'op.pl', 'abv.bg', 'libero.it',
  'virgilio.it', 'tiscali.it', 'alice.it', 'orange.fr', 'wanadoo.fr', 'free.fr',
  'laposte.net', 'sfr.fr', 'bbox.fr', 't-online.de', 'freenet.de', 'arcor.de',
  'btinternet.com', 'sky.com', 'virginmedia.com', 'ntlworld.com', 'talktalk.net',
  'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net', 'cox.net',
  'bellsouth.net', 'charter.net', 'earthlink.net', 'juno.com', 'rogers.com',
  'shaw.ca', 'sympatico.ca', 'telus.net', 'bigpond.com', 'optusnet.com.au',
  'uol.com.br', 'bol.com.br', 'terra.com.br', 'ig.com.br', 'rediffmail.com',
]);

/** Is this address from a free mailbox provider (so its domain is not a site)? */
export function isFreemailAddress(address: string): boolean {
  const domain = normalizeEmail(address).split('@')[1];
  return domain ? FREEMAIL_DOMAINS.has(domain) : false;
}

/**
 * Hosted support desks and bulk-mail senders. Mail arrives from these domains
 * constantly, but none of them is a website you can buy a guest post on, so
 * their domain must never become a priced site.
 */
const NON_SITE_SUFFIXES = [
  'zendesk.com', 'freshdesk.com', 'helpscoutapp.com', 'helpscout.com', 'intercom-mail.com',
  'intercom.io', 'hubspotemail.net', 'desk.com', 'kayako.com', 'groovehq.com', 'tawk.to',
  'crisp.chat', 'frontapp.com', 'helpshift.com', 'zohodesk.com', 'service-now.com',
  'sendgrid.net', 'mailchimp.com', 'list-manage.com', 'awstrack.me', 'mailgun.org',
  'sparkpostmail.com', 'mandrillapp.com', 'sendinblue.com', 'brevo.com',
];

/** True for a support-desk / bulk-mail host — never a publisher's website. */
export function isNonSiteDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return NON_SITE_SUFFIXES.some((s) => d === s || d.endsWith(`.${s}`));
}

// Hostname-shaped tokens. The TLD guard (2+ letters, no digits) keeps version
// numbers and prices out; the extension list keeps filenames out.
const HOSTNAME_RE = /\b((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24})\b/gi;
const FILE_EXTENSIONS = new Set(['pdf', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'csv', 'xlsx', 'docx', 'doc', 'zip', 'html', 'htm', 'php', 'txt']);

/**
 * Every website domain named anywhere in a reply — in a link, an address, or as
 * bare text. Infrastructure hosts, free mailboxes and filenames are dropped, so
 * what is left is the set of SITES the email talks about.
 */
export function domainsMentionedIn(text: string): string[] {
  const found = new Set<string>();
  for (const [, host] of text.matchAll(HOSTNAME_RE)) {
    const lower = host.toLowerCase();
    const tld = lower.slice(lower.lastIndexOf('.') + 1);
    if (FILE_EXTENSIONS.has(tld)) continue;
    const normalized = normalizeDomain(lower);
    if (!normalized || FREEMAIL_DOMAINS.has(normalized) || isNonSiteDomain(normalized)) continue;
    if (normalized.endsWith('.google.com') || normalized === 'google.com') continue;
    found.add(normalized);
  }
  return [...found];
}

/**
 * May an UNTAGGED price be attributed to the sender's own email domain?
 *
 * Usually yes — a publisher writing from info@theirsite.com about theirsite.com
 * is the common case, and they often never spell the domain out. The answer is
 * no in two situations, both seen in real replies:
 *   - the address belongs to a support desk or bulk mailer, which is not a site;
 *   - the email is a rate card for a NETWORK of other sites and never mentions
 *     the sender's own domain at all. Attributing those prices to the sender
 *     files other people's rates under the agency's corporate domain.
 *
 * Only consulted for an UNMATCHED reply. With a target, the contacted site is a
 * fact and no inference may override it.
 */
export function senderSiteIsCredible(ownDomain: string, replyText: string): boolean {
  if (isNonSiteDomain(ownDomain)) return false;
  const mentioned = domainsMentionedIn(replyText);
  if (mentioned.includes(normalizeDomain(ownDomain))) return true;
  // One stray link is nothing; a list of other people's sites is a rate card.
  return mentioned.length < 2;
}

/**
 * The sender's own website, inferred from their address — "the site they are
 * writing about" when we have no target to tell us. Undefined for a free mailbox
 * (see FREEMAIL_DOMAINS) and for anything that isn't a parseable address.
 *
 * Deliberately NOT used when a target exists: there the contacted site is a fact,
 * and an inference must never override it.
 */
export function senderSiteDomain(address: string): string | undefined {
  if (isFreemailAddress(address)) return undefined;
  const domain = normalizeEmail(address).split('@')[1];
  if (!domain) return undefined;
  return normalizeDomain(domain) || undefined;
}

/**
 * True once we already have a substantive outcome for this target (a parsed
 * result — price/canPost, or an opt-out).
 *
 * NOTE: with per-domain price history this NO LONGER gates extraction — a later
 * substantive reply must still be extracted so it appends a PriceRecord
 * (PRICE-HISTORY-PLAN.md §5.2 Requirement 2). `target.result` is preserved as the
 * latest substantive snapshot by rollUp's own guard, not by skipping the reply.
 * Kept for callers that want the "has an answer" predicate.
 */
export function isTargetResolved(target: Pick<Target, 'result'> | undefined): boolean {
  return target?.result != null;
}

/**
 * Build an `email → domain[]` map from all targets (D4/M1). A sender's untagged
 * offer is attributed to their associated domain; a sender associated with 2+
 * domains is ambiguous and pushed to review (D11). Keyed by normalized email,
 * values are normalized, de-duplicated domains.
 */
export function emailToDomains(
  targets: Pick<Target, 'contactEmail' | 'websiteUrl'>[],
): Map<string, string[]> {
  const sets = new Map<string, Set<string>>();
  for (const t of targets) {
    const email = normalizeEmail(t.contactEmail);
    const domain = normalizeDomain(t.websiteUrl);
    if (!email || !domain) continue;
    if (!sets.has(email)) sets.set(email, new Set());
    sets.get(email)!.add(domain);
  }
  return new Map([...sets].map(([email, ds]) => [email, [...ds]]));
}

/** One domain's slice of a reply's offers, with how it was attributed (D4). */
export interface DomainGroup {
  domain: string;
  offers: PostOffer[];
  attribution: 'sender' | 'named';
}

export interface AttributionResult {
  groups: DomainGroup[];
  /** D11 ambiguity reasons to push onto reply.review[]. */
  reviewReasons: string[];
  /** True when MAX_DOMAINS_PER_REPLY fired and domains were dropped. The caller
   *  uses it to trim the reply/target snapshot to what was actually stored — an
   *  uncapped reply keeps every offer, including ones too ambiguous to attribute,
   *  because a human still needs to see those. */
  capped: boolean;
}

/**
 * How many distinct domains one reply may price before we stop believing it is a
 * genuine per-site answer.
 *
 * A publisher naming a handful of their own sites ("we can also post on
 * casik_super.ua and ultra_casik.net") is an ordinary, useful reply — we want all
 * of those. A reply that resolves to hundreds of domains is a different animal: a
 * bulk rate card ("check our prices at example.net/price" → 2500 rows), where the
 * only thing we actually asked about is the contacted site. Storing the rest
 * would flood the known-domains list with sites we never researched, never
 * contacted, and cannot vouch for.
 *
 * The prompt already tells the model to extract only the contacted site's row
 * from a multi-site list (see RESEARCH_ADDENDUM); this is the deterministic
 * backstop for when it does not comply, in the same spirit as isNonGuestProduct.
 */
export const MAX_DOMAINS_PER_REPLY = 10;

/**
 * Split a reply's offers into per-domain groups (PRICE-HISTORY-PLAN.md §5.2):
 *  - offer tagged with a `website` → that site's domain, attribution 'named' (M2);
 *  - untagged offer + a matched target → THAT target's domain, 'sender' (M1);
 *  - untagged offer + sender→exactly 1 domain → that domain, 'sender' (M1);
 *  - untagged offer + sender→2+ domains → ambiguous, push a review reason, skip;
 *  - untagged offer + sender→0 domains → nothing to attribute.
 *
 * Then caps the result at MAX_DOMAINS_PER_REPLY distinct domains: past that, the
 * reply is a bulk rate card rather than an answer about specific sites, so only
 * the contacted site survives (see `capDomains`).
 *
 * `ownDomain` is the domain of the target the reply was matched to. It takes
 * precedence because a matched reply is an answer to the mail we sent ABOUT that
 * site, so an untagged price is that site's price. Without it, an owner running
 * several of our targets from one mailbox made every untagged price ambiguous —
 * and the contacted site ended up with no prices at all while the sites they
 * happened to name got them.
 *
 * Pure — the caller owns persistence.
 */
export function attributeOffers(
  offers: PostOffer[],
  senderDomains: string[],
  ownDomain?: string,
): AttributionResult {
  const groups = new Map<string, DomainGroup>();
  const reviewReasons: string[] = [];
  let flaggedMulti = false;

  const add = (domain: string, attribution: 'sender' | 'named', offer: PostOffer) => {
    if (!domain) return;
    const g = groups.get(domain) ?? { domain, offers: [], attribution };
    g.offers.push(offer);
    groups.set(domain, g);
  };

  for (const offer of offers) {
    const website = offer.website?.trim();
    if (website) {
      add(normalizeDomain(website), 'named', offer);
      continue;
    }
    if (ownDomain) {
      add(ownDomain, 'sender', offer);
    } else if (senderDomains.length === 1) {
      add(senderDomains[0]!, 'sender', offer);
    } else if (senderDomains.length >= 2 && !flaggedMulti) {
      reviewReasons.push(
        `Untagged price(s) but the sender is associated with ${senderDomains.length} sites ` +
          `(${senderDomains.join(', ')}) — attribute the price manually.`,
      );
      flaggedMulti = true;
    }
    // 0 domains, no website → nothing to attribute.
  }

  return capDomains([...groups.values()], senderDomains, ownDomain, reviewReasons);
}

/**
 * Enforce MAX_DOMAINS_PER_REPLY. Under the cap, everything stands. Over it, we
 * keep ONLY the site we actually asked about and drop the rest — the reply is a
 * price list, and the one row we can trust is the one we wrote to them about.
 *
 * "The site we asked about" is the matched target's domain; failing that, the
 * sender's domain when it is unambiguous. If neither is among the priced
 * domains, nothing is kept: a bulk list that does not even mention the contacted
 * site has told us nothing about it, and guessing which of 500 rows to believe
 * would be worse than recording none.
 *
 * Either way a review reason is pushed, so the reply surfaces for a human rather
 * than silently losing data.
 */
function capDomains(
  groups: DomainGroup[],
  senderDomains: string[],
  ownDomain: string | undefined,
  reviewReasons: string[],
): AttributionResult {
  if (groups.length <= MAX_DOMAINS_PER_REPLY) return { groups, reviewReasons, capped: false };

  const has = (d?: string) => (d ? groups.find((g) => g.domain === d) : undefined);
  const kept = has(ownDomain) ?? (senderDomains.length === 1 ? has(senderDomains[0]) : undefined);

  reviewReasons.push(
    `Reply priced ${groups.length} sites (cap is ${MAX_DOMAINS_PER_REPLY}) — looks like a bulk price list, not an answer about specific sites. ` +
      (kept
        ? `Kept only the contacted site (${kept.domain}); the other ${groups.length - 1} were ignored.`
        : `None of them is the contacted site, so no prices were recorded.`),
  );
  return { groups: kept ? [kept] : [], reviewReasons, capped: true };
}

/**
 * Resolve an inbound message to a target.
 * @param incoming      the inbound message's threadId + fromAddress
 * @param sentOutreaches our sent outreaches that carry a resolved threadId
 * @param awaiting       targets we've contacted and are awaiting a reply from
 */
export function matchReply(
  incoming: IncomingRef,
  sentOutreaches: SentOutreachRef[],
  awaiting: AwaitingTargetRef[],
): MatchResult {
  // 1. Native thread id — the reliable path.
  if (incoming.threadId) {
    const hit = sentOutreaches.find((o) => o.threadId && o.threadId === incoming.threadId);
    if (hit) return { targetId: hit.targetId, method: 'threadId' };
  }
  // 2. Exact from-address against awaiting targets — mops up orphans Gmail
  //    itself couldn't thread. Best-effort: a reply from a different address
  //    than the one we emailed won't match here (only threadId saves those).
  const from = normalizeEmail(incoming.fromAddress);
  const byAddr = awaiting.find((t) => normalizeEmail(t.contactEmail) === from);
  if (byAddr) return { targetId: byAddr.targetId, method: 'fromAddress' };

  // 3. Give up — surfaced in the UI's unmatched queue.
  return { method: 'unmatched' };
}

export interface BounceResult {
  isBounce: boolean;
  failedRecipient?: string;
}

const BOUNCE_SENDERS = [/mailer-daemon@/i, /postmaster@/i];
// Common DSN markers for the failed-recipient address.
const RECIPIENT_PATTERNS = [
  /Final-Recipient:\s*rfc822;\s*([^\s<>]+@[^\s<>]+)/i,
  /Original-Recipient:\s*rfc822;\s*([^\s<>]+@[^\s<>]+)/i,
  /(?:to|recipient)\s*[:<]\s*([^\s<>]+@[^\s<>]+)/i,
];

/**
 * Detect a delivery-failure (bounce) message and recover the failed recipient
 * from the DSN body when possible. Header reconstruction stays out of scope —
 * this is intentionally a light heuristic over the from-address + DSN body.
 */
export function detectBounce(fromAddress: string, text: string): BounceResult {
  const from = normalizeEmail(fromAddress);
  const looksLikeBounce =
    BOUNCE_SENDERS.some((re) => re.test(from)) ||
    /delivery status notification|delivery has failed|undeliverable/i.test(text);
  if (!looksLikeBounce) return { isBounce: false };

  for (const re of RECIPIENT_PATTERNS) {
    const m = text.match(re);
    if (m && m[1]) return { isBounce: true, failedRecipient: normalizeEmail(m[1]) };
  }
  return { isBounce: true };
}
