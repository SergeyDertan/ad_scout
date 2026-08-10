// The extraction seam: the SLOW half of a poll pass — the LLM call and the
// read-only context it needs — with the Store and Config lifted out into plain
// data.
//
// poll-pass splits every extraction in two: `extractReply` (slow, writes
// nothing) then `persistExtraction` (fast, every write). This module is that
// first half expressed as JSON-in / JSON-out, so the same code can run in the
// agent process OR on a machine that has no database at all — see
// server/remote-hub.ts and scripts/remote-worker.ts, where the input travels
// over HTTP to a second Claude subscription and the output travels back.
//
// Keeping it in ONE place is the whole point of the split. A remotely extracted
// reply has to be indistinguishable from a locally extracted one, down to the
// prompt hash it records; a worker-side reimplementation of "how we ask" would
// drift and quietly poison the provenance every stored price carries.

import { normalizeDomain } from '../domain/domain';
import { pitchStyleForBatch } from '../domain/pitch';
import { senderSiteDomain, senderSiteIsCredible } from '../domain/reply-matching';
import type { Niche, PitchProfile, Reply, Target } from '../domain/types';
import type { ExtractionOutcome, Extractor } from '../services/extractor';

/**
 * Everything the model half needs, as plain JSON — no Store, no Config, no
 * ports. This is the wire format the hub hands a remote worker.
 */
export interface ExtractInput {
  reply: Reply;
  /** The target this reply was matched to. Absent for an unmatched reply — that
   *  is a normal case, not an error (price history is keyed by domain). */
  target?: Target;
  /** Learned niches (`store.listNiches()`); the seed niches are merged in by the
   *  extractor itself. */
  niches: Niche[];
  /** The HOST's pitch profile. Sent rather than read from the worker's own env,
   *  so a second machine can never quietly reframe what we asked publishers. */
  pitch: PitchProfile;
}

/** What `extractReplyCore` produces — and what `persistExtraction` consumes. */
export interface ExtractedReply {
  outcome: ExtractionOutcome;
  /** The site this reply is about, once vetted — what offers attribute to. */
  ownDomain?: string;
  /** What we inferred before vetting, kept for the review message. */
  guessedDomain?: string;
  senderSiteRejected: boolean;
}

/**
 * Run the extractor over one reply. Writes nothing and touches no I/O beyond the
 * model call, so many of these may be in flight at once (see
 * ExtractOptions.concurrency) and it is safe to retry.
 */
export async function extractReplyCore(
  extractor: Extractor,
  { reply, target, niches, pitch }: ExtractInput,
): Promise<ExtractedReply> {
  // The batch the target came from decides how a niche-less flat price is read:
  // the historical casino-specific "first" batch ⇒ casino; everything else ⇒ broad.
  // A targetless reply has no batch, and 'broad' is the right reading for it: we
  // never asked it a casino-specific question (we never asked it anything).
  const pitchStyle = pitchStyleForBatch(target?.batchId);
  // The site this reply is ABOUT. With a target that is a fact; without one it is
  // inferred from the sender's own domain, and is undefined for a free mailbox —
  // in which case the model is told nothing rather than something wrong.
  const guessedDomain = target
    ? normalizeDomain(target.websiteUrl) || undefined
    : senderSiteDomain(reply.fromAddress);
  // An inferred domain has to earn it: a support desk, or a network rate card
  // that never names the sender's own site, would otherwise file other people's
  // prices under the sender's domain. Dropping it here also keeps the model from
  // being told "prices belong to X" when X is not what the email is about.
  const senderSiteRejected =
    !target && guessedDomain != null && !senderSiteIsCredible(guessedDomain, reply.text);
  const ownDomain = senderSiteRejected ? undefined : guessedDomain;
  const outcome = await extractor.extract(
    pitch,
    reply.text,
    niches,
    reply.attachments ?? [],
    // siteDomain lets the model find THIS site's row in a multi-site price list.
    { pitchStyle, ...(ownDomain ? { siteDomain: ownDomain } : {}) },
  );
  return {
    outcome,
    senderSiteRejected,
    ...(ownDomain ? { ownDomain } : {}),
    ...(guessedDomain ? { guessedDomain } : {}),
  };
}
