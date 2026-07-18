// Poll-pass (overview.md §8). Dedupe inbound by emailId → drop ignored senders →
// detect bounce → match (threadId → fromAddress → unmatched) → store reply →
// extract → roll up onto the target AND append per-domain price history
// (PRICE-HISTORY-PLAN.md §5.2). Opt-outs and bounces add to the persistent
// suppression list; blanket declines add a domain exclusion; AI-flagged spam
// grows the ignore list.

import { normalizeDomain } from '../domain/domain';
import { LABELS, labelForResult, type OutcomeLabel } from '../domain/labels';
import {
  attributeOffers,
  detectBounce,
  emailToDomains,
  matchReply,
  normalizeEmail,
  type AwaitingTargetRef,
  type DomainGroup,
  type SentOutreachRef,
} from '../domain/reply-matching';
import {
  AWAITING_INTENTS,
  type Account,
  type Niche,
  type OutreachResult,
  type PriceRecord,
  type Reply,
  type Suppression,
  type Target,
} from '../domain/types';
import type { Clock } from '../lib/clock';
import { describeError, UsageLimitError } from '../lib/errors';
import { newId } from '../lib/ids';
import { logger } from '../lib/logger';
import type { EmailProvider, IncomingEmail } from '../ports/email-provider';
import type { Store } from '../ports/store';
import type { Extractor } from '../services/extractor';
import type { Config } from '../config';

export interface PollDeps {
  store: Store;
  email: EmailProvider;
  extractor: Extractor;
  clock: Clock;
  config: Config;
}

export interface PollReport {
  fetched: number;
  deduped: number;
  bounced: number;
  matched: number;
  unmatched: number;
  extracted: number;
  extractionFailed: number;
  /** Matched replies saved without extraction (empty body). */
  skipped: number;
  /** Inbound dropped pre-processing (ignore list) or set aside as AI-detected spam. */
  ignored: number;
}

function emptyReport(): PollReport {
  return {
    fetched: 0,
    deduped: 0,
    bounced: 0,
    matched: 0,
    unmatched: 0,
    extracted: 0,
    extractionFailed: 0,
    skipped: 0,
    ignored: 0,
  };
}

export async function runPollPass(deps: PollDeps): Promise<PollReport> {
  const { store, email, clock } = deps;
  const report = emptyReport();

  // Matching refs computed once for the pass.
  const sentRefs: SentOutreachRef[] = (await store.listOutreaches())
    .filter((o) => o.threadId)
    .map((o) => ({ targetId: o.targetId, threadId: o.threadId }));
  const allTargets = await store.listTargets();
  const awaiting: AwaitingTargetRef[] = allTargets
    .filter((t) => t.status === 'contacted' || t.status === 'reserved')
    .map((t) => ({ targetId: t.id, contactEmail: t.contactEmail }));
  const emailDomainMap = emailToDomains(allTargets);

  for (const account of await store.listAccounts()) {
    if (account.status === 'paused') continue;
    const since = account.pollCursor?.lastPolledAt
      ? new Date(account.pollCursor.lastPolledAt)
      : undefined;

    let messages: IncomingEmail[];
    try {
      messages = await email.fetchReplies(account, since);
    } catch (err) {
      logger.warn('fetchReplies failed', {
        account: account.id,
        email: account.email,
        ...describeError(err),
      });
      continue;
    }
    report.fetched += messages.length;

    for (const msg of messages) {
      await handleMessage(deps, account, msg, sentRefs, awaiting, emailDomainMap, report);
    }

    // Advance the cursor. Merge (don't overwrite): the gmail-api provider may
    // have written a fresh historyId into pollCursor during fetchReplies.
    await store.updateAccount(account.id, (current) => ({
      ...current,
      pollCursor: {
        ...current.pollCursor,
        mailbox: 'INBOX',
        lastPolledAt: clock.now().toISOString(),
      },
    }));
  }

  await retryFailedExtractions(deps, report);

  return report;
}

/** Persist niches the extractor learned for the first time (idempotent by key). */
async function persistDiscovered(store: Store, discovered: Niche[], clock: Clock): Promise<void> {
  for (const n of discovered) {
    await store.putNiche({ ...n, createdAt: n.createdAt ?? clock.now().toISOString() });
  }
}

async function retryFailedExtractions(deps: PollDeps, report: PollReport): Promise<void> {
  const { extracted, failed, ignored } = await extractPendingReplies(deps);
  report.extracted += extracted;
  report.extractionFailed += failed;
  report.ignored += ignored;
}

export interface ExtractOptions {
  /** Progress sink (defaults to no-op). The re-extract script passes console.log. */
  log?: (msg: string) => void;
  /** Cap the number of replies extracted this run (migration pacing). */
  limit?: number;
  /** Milliseconds to sleep between replies (migration pacing). */
  sleepMs?: number;
}

/**
 * Re-extract every reply whose extraction is `pending`/`failed` (and is matched
 * to a target), WITHOUT fetching the mailbox. Same extract → persist niches →
 * roll-up + price-history path a normal poll uses, so target status/result and
 * the per-domain records are re-derived identically. Used by the poll pass's
 * retry step, the re-extract script, and the resumable migration (§8).
 */
export async function extractPendingReplies(
  deps: PollDeps,
  opts: ExtractOptions = {},
): Promise<{ extracted: number; failed: number; ignored: number; stoppedByLimit: boolean; resetAt?: Date }> {
  const { store } = deps;
  const log = opts.log ?? (() => {});
  const emailDomainMap = emailToDomains(await store.listTargets());
  const pending = (await store.listReplies()).filter(
    (r) => (r.extractionStatus === 'failed' || r.extractionStatus === 'pending') && r.targetId,
  );
  const work = opts.limit != null ? pending.slice(0, opts.limit) : pending;
  let extracted = 0;
  let failed = 0;
  let ignored = 0;
  let i = 0;
  for (const reply of work) {
    i++;
    const target = await store.getTarget(reply.targetId!);
    if (!target) {
      log(`[${i}/${work.length}] skip ${reply.fromAddress} — no target`);
      continue;
    }
    // The account that owns this reply's mailbox — needed to (re)label it. Absent
    // ⇒ labeling is skipped (best-effort), extraction still runs.
    const account = target.assignedAccountId
      ? await store.getAccount(target.assignedAccountId)
      : undefined;
    try {
      const outcome = await ingestReply(deps, reply, target, emailDomainMap);
      await store.putReply(reply);
      if (outcome.kind === 'ignored') {
        ignored++;
        if (account) await applyLabel(deps, account, reply.emailId, LABELS.ignored);
        log(`[${i}/${work.length}] spam ${reply.fromAddress} — added to ignore list`);
      } else {
        extracted++;
        if (account) await applyLabel(deps, account, reply.emailId, outcome.label);
        const offers = reply.parsed?.offers?.length ?? 0;
        log(`[${i}/${work.length}] ok   ${target.websiteUrl} — intent=${reply.parsed?.intent ?? 'answer'}, ${offers} offer(s)`);
      }
    } catch (err) {
      // Usage/session limit → stop the run WITHOUT marking this reply failed, so a
      // later run resumes exactly here. State is per-reply, so this is safe.
      if (err instanceof UsageLimitError) {
        const when = err.resetAt ? ` — resets ${err.resetAt.toLocaleString()}` : '';
        log(`[${i}/${work.length}] STOP claude usage limit reached${when}. Re-run to resume.`);
        return { extracted, failed, ignored, stoppedByLimit: true, ...(err.resetAt ? { resetAt: err.resetAt } : {}) };
      }
      reply.extractionStatus = 'failed';
      await store.putReply(reply);
      if (account) await applyLabel(deps, account, reply.emailId, LABELS.matched);
      failed++;
      log(`[${i}/${work.length}] FAIL ${target.websiteUrl} — ${err instanceof Error ? err.message : String(err)}`);
    }
    if (opts.sleepMs) await sleep(opts.sleepMs);
  }
  return { extracted, failed, ignored, stoppedByLimit: false };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type IngestResult = { kind: 'done'; label: OutcomeLabel } | { kind: 'ignored' };

/**
 * Extract a reply and apply every consequence: persist learned niches, handle
 * AI-detected spam (→ ignore list, no records), roll the outcome up onto the
 * target, append per-domain PriceRecords, exclude a blanket-declining domain, and
 * lift a domain exclusion on a positive record. Mutates `reply` in place (parsed,
 * review, extractionStatus). Throws on extractor failure so the caller can mark it.
 */
async function ingestReply(
  deps: PollDeps,
  reply: Reply,
  target: Target,
  emailDomainMap: Map<string, string[]>,
): Promise<IngestResult> {
  const { store, extractor, clock, config } = deps;
  const knownNiches = await store.listNiches();
  const outcome = await extractor.extract(
    config.pitch,
    reply.text,
    knownNiches,
    reply.attachments ?? [],
  );
  await persistDiscovered(store, outcome.discovered, clock);

  // Spam (D7): set the reply aside, grow the ignore list, write NO price records.
  if (outcome.isSpam) {
    const from = normalizeEmail(reply.fromAddress);
    await store.putIgnore({
      id: `email:${from}`,
      kind: 'email',
      value: from,
      reason: outcome.result.reasoning?.trim() || 'AI-detected spam (unrelated to posting/ads)',
      emailId: reply.emailId,
      at: clock.now().toISOString(),
    });
    reply.extractionStatus = 'skipped';
    reply.review = undefined;
    return { kind: 'ignored' };
  }

  const parsed = outcome.result;

  // Attribute this reply's offers to domains (M1 sender / M2 named), collecting
  // any D11 ambiguity as review reasons.
  const senderDomains = senderDomainsFor(emailDomainMap, reply.fromAddress, target);
  const { groups, reviewReasons } = attributeOffers(parsed.offers, senderDomains);
  const review = [...outcome.review, ...reviewReasons];

  await rollUp(store, target, reply, parsed, review, clock);
  await writePriceRecords(store, reply, target, parsed, groups, senderDomains, clock);
  await handleDeclineExclusion(store, reply, target, parsed, clock);
  await handleReversal(store, groups);

  return { kind: 'done', label: labelForResult(parsed) };
}

/** The domains a reply's untagged offers attribute to: the sender's associated
 *  domains (from all targets) PLUS the matched target's own domain, so a matched
 *  reply always attributes to at least the site we contacted. */
function senderDomainsFor(
  emailDomainMap: Map<string, string[]>,
  fromAddress: string,
  target: Target,
): string[] {
  const set = new Set(emailDomainMap.get(normalizeEmail(fromAddress)) ?? []);
  const own = normalizeDomain(target.websiteUrl);
  if (own) set.add(own);
  return [...set];
}

/** An offer that asserts the domain CAN be posted to (a definite yes or a price). */
function isPositiveOffer(o: { canPost: string; price?: unknown }): boolean {
  return o.canPost === 'yes' || o.price != null;
}

/** Write one append-only PriceRecord per attributed domain group. A substantive
 *  positive answer with no attributable offers still records a bare "can post, no
 *  price" for the single sender domain (offers:[]) — PRICE-HISTORY-PLAN.md §3.1. */
async function writePriceRecords(
  store: Store,
  reply: Reply,
  target: Target,
  parsed: OutreachResult,
  groups: DomainGroup[],
  senderDomains: string[],
  clock: Clock,
): Promise<void> {
  const ownDomain = normalizeDomain(target.websiteUrl);
  const write = async (group: DomainGroup): Promise<void> => {
    const record: PriceRecord = {
      id: newId('pricerecord'),
      domain: group.domain,
      offers: group.offers,
      observedAt: reply.receivedAt ?? clock.now().toISOString(),
      sourceEmail: normalizeEmail(reply.fromAddress),
      sourceMessageId: reply.rfcMessageId,
      replyId: reply.id,
      ...(group.domain === ownDomain ? { targetId: target.id } : {}),
      attribution: group.attribution,
      ...(parsed.optOut ? { optOut: true } : {}),
    };
    await store.putPriceRecord(record);
  };

  for (const group of groups) await write(group);

  // Bare "yes, we can post" with no priced cell — record the willingness for the
  // one unambiguous sender domain so the history reflects it.
  if (
    groups.length === 0 &&
    parsed.offers.length === 0 &&
    parsed.canPost === 'yes' &&
    senderDomains.length === 1
  ) {
    await write({ domain: senderDomains[0]!, offers: [], attribution: 'sender' });
  }
}

/** Blanket decline (intent 'decline') for the contacted site → exclude the domain
 *  (D8). A per-cell canPost:'no' is just a price cell and does NOT exclude. */
async function handleDeclineExclusion(
  store: Store,
  reply: Reply,
  target: Target,
  parsed: OutreachResult,
  clock: Clock,
): Promise<void> {
  if (parsed.intent !== 'decline') return;
  const domain = normalizeDomain(target.websiteUrl);
  if (!domain) return;
  await store.putDomainExclusion({
    id: domain,
    domain,
    reason: 'declined',
    sourceReplyId: reply.id,
    at: clock.now().toISOString(),
  });
}

/** Reversal (D10): a positive record for a domain lifts an AUTOMATIC ('declined')
 *  exclusion. Manual exclusions are left for explicit removal via the API. */
async function handleReversal(store: Store, groups: DomainGroup[]): Promise<void> {
  const positives = new Set(
    groups.filter((g) => g.offers.some(isPositiveOffer)).map((g) => g.domain),
  );
  if (positives.size === 0) return;
  for (const excl of await store.listDomainExclusions()) {
    if (excl.reason === 'declined' && positives.has(excl.domain)) {
      await store.deleteDomainExclusion(excl.domain);
    }
  }
}

/** Whether a parsed result is a substantive answer worth snapshotting onto the
 *  target (has priced/addressed offers, or the extractor classified it 'answer').
 *  Guards target.result from being clobbered by later non-substantive chatter. */
function isSubstantive(parsed: OutreachResult): boolean {
  return (parsed.offers?.length ?? 0) > 0 || parsed.intent === 'answer';
}

/**
 * Set the reply's parsed result + review flags and roll the outcome up onto the
 * target. Opt-out excludes + suppresses; a blanket decline excludes the target; a
 * substantive answer marks it 'replied' and snapshots the result. A holding/auto
 * reply is NOT a real answer — leave the target 'contacted' so follow-ups keep
 * chasing. A non-substantive reply on an already-answered target does NOT clobber
 * the known result (per-domain history still records via the caller).
 *
 * `review` carries ONLY genuine "the system couldn't process this" reasons plus
 * D11 attribution ambiguity. The benign "no answer yet" state is captured in
 * `parsed.intent` (holding/auto_reply), not review.
 */
async function rollUp(
  store: Store,
  target: Target,
  reply: Reply,
  parsed: OutreachResult,
  review: string[],
  clock: Clock,
): Promise<void> {
  const awaiting = parsed.intent != null && AWAITING_INTENTS.includes(parsed.intent);
  reply.parsed = parsed;
  reply.review = review.length ? review : undefined;
  reply.extractionStatus = 'done';

  if (parsed.optOut) {
    await store.updateTarget(target.id, (t) => ({ ...t, status: 'excluded', result: parsed }));
    await suppress(store, target.contactEmail, 'opt_out', clock);
  } else if (parsed.intent === 'decline') {
    // Blanket decline → target excluded (the DomainExclusion doc is written by the
    // caller's handleDeclineExclusion).
    await store.updateTarget(target.id, (t) => ({ ...t, status: 'excluded', result: parsed }));
  } else if (awaiting) {
    // Leave the target 'contacted' — the real reply (or a follow-up) is expected.
  } else if (isSubstantive(parsed)) {
    await store.updateTarget(target.id, (t) => ({ ...t, status: 'replied', result: parsed }));
  } else {
    // question/other with nothing substantive — preserve any known result.
  }
}

async function suppress(
  store: Store,
  email: string,
  reason: Suppression['reason'],
  clock: Clock,
): Promise<void> {
  const norm = normalizeEmail(email);
  await store.addSuppression({ id: norm, email: norm, reason, at: clock.now().toISOString() });
}

/** Mark a fetched message read — "the system saw it". Never throws: a mailbox
 *  mutation failure (e.g. an account still on the old readonly scope) must not
 *  fail the pass. */
async function markRead(deps: PollDeps, account: Account, emailId: string): Promise<void> {
  try {
    await deps.email.markRead(account, emailId);
  } catch (err) {
    logger.warn('markRead failed', { account: account.id, emailId, ...describeError(err) });
  }
}

/** Apply a decision label to a message (best-effort, same non-fatal contract). */
async function applyLabel(
  deps: PollDeps,
  account: Account,
  emailId: string,
  label: OutcomeLabel,
): Promise<void> {
  try {
    await deps.email.applyLabel(account, emailId, label);
  } catch (err) {
    logger.warn('applyLabel failed', { account: account.id, emailId, label, ...describeError(err) });
  }
}

async function handleMessage(
  deps: PollDeps,
  account: Account,
  msg: IncomingEmail,
  sentRefs: SentOutreachRef[],
  awaiting: AwaitingTargetRef[],
  emailDomainMap: Map<string, string[]>,
  report: PollReport,
): Promise<void> {
  const { store } = deps;

  // Dedupe on the stable emailId.
  if (await store.getReplyByEmailId(msg.emailId)) {
    report.deduped++;
    return;
  }

  // The system has now fetched and seen this message — mark it read regardless of
  // what we decide about it below. The label records the decision.
  await markRead(deps, account, msg.emailId);

  // Ignore list (D6): drop spam / automated senders before any work or storage.
  if (await store.isIgnored(msg.fromAddress)) {
    await applyLabel(deps, account, msg.emailId, LABELS.ignored);
    report.ignored++;
    return;
  }

  // Bounce?
  const bounce = detectBounce(msg.fromAddress, msg.text);
  if (bounce.isBounce) {
    const failed = bounce.failedRecipient;
    if (failed) {
      await suppress(store, failed, 'bounce', deps.clock);
      const target = (await store.listTargets()).find(
        (t) => normalizeEmail(t.contactEmail) === failed,
      );
      if (target) await store.updateTarget(target.id, (t) => ({ ...t, status: 'bounced' }));
    }
    await applyLabel(deps, account, msg.emailId, LABELS.bounced);
    report.bounced++;
    return;
  }

  // Match.
  const match = matchReply(
    { ...(msg.threadId ? { threadId: msg.threadId } : {}), fromAddress: msg.fromAddress },
    sentRefs,
    awaiting,
  );

  const reply: Reply = {
    id: newId('reply'),
    emailId: msg.emailId,
    ...(msg.threadId ? { threadId: msg.threadId } : {}),
    rfcMessageId: msg.rfcMessageId,
    fromAddress: msg.fromAddress,
    ...(match.targetId ? { targetId: match.targetId } : {}),
    matchMethod: match.method,
    receivedAt: msg.receivedAt,
    text: msg.text,
    ...(msg.attachments?.length ? { attachments: msg.attachments } : {}),
    extractionStatus: 'pending',
  };

  if (!match.targetId) {
    await applyLabel(deps, account, msg.emailId, LABELS.unmatched);
    report.unmatched++;
    await store.putReply(reply);
    return;
  }
  report.matched++;

  // Empty body — nothing to extract; save it for the record.
  const target = await store.getTarget(match.targetId);
  if (!target) {
    await store.putReply(reply);
    return;
  }
  if (!msg.text?.trim()) {
    reply.extractionStatus = 'skipped';
    await applyLabel(deps, account, msg.emailId, LABELS.matched);
    report.skipped++;
    await store.putReply(reply);
    return;
  }

  // Extract + roll up + append price history.
  try {
    const outcome = await ingestReply(deps, reply, target, emailDomainMap);
    if (outcome.kind === 'ignored') {
      await applyLabel(deps, account, msg.emailId, LABELS.ignored);
      report.ignored++;
    } else {
      await applyLabel(deps, account, msg.emailId, outcome.label);
      report.extracted++;
    }
  } catch (err) {
    reply.extractionStatus = 'failed';
    // Couldn't classify it, but it IS a matched reply — label it as such.
    await applyLabel(deps, account, msg.emailId, LABELS.matched);
    report.extractionFailed++;
    logger.warn('extraction failed', {
      reply: reply.id,
      ...describeError(err),
    });
  }

  await store.putReply(reply);
}
