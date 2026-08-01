// The `api` object, backed by a published snapshot instead of a live server.
//
// The viewer build aliases './api' to this file (see web/vite.config.ts), so
// DomainsView, ResponsesView and the export code run UNCHANGED against static
// JSON in Cloud Storage. Keeping the seam here — rather than threading a data
// source through every component — is what stops the viewer from becoming a
// second, drifting copy of the console.
//
// Two things happen on the way through:
//   1. files are fetched (and cached) from the snapshot;
//   2. every niche is stamped with the VIEWER OWNER's sensitivity call, since
//      the snapshot deliberately carries none (see viewer/classification.ts).
//
// Everything that writes throws. The viewer has nothing to write to, and a
// loud failure beats a button that silently does nothing.

import type {
  BatchRow,
  DomainDetail,
  DomainSummary,
  ExtractionDebug,
  Niche,
  PostOffer,
  PriceRecordRow,
  ResponseRow,
} from './types';
import { classify, classifyNiche } from './viewer/classification';
import { domainFile, replyFile } from './viewer/paths';
import { load } from './viewer/snapshot-client';

function readOnly(action: string): never {
  throw new Error(`${action} is not available in the read-only viewer`);
}

function classifyOffers(offers?: PostOffer[]): PostOffer[] | undefined {
  return offers?.map(classify);
}

function classifyReply(r: ResponseRow): ResponseRow {
  return r.parsed?.offers ? { ...r, parsed: { ...r.parsed, offers: classifyOffers(r.parsed.offers)! } } : r;
}

function classifyRecord(rec: PriceRecordRow): PriceRecordRow {
  return { ...rec, offers: rec.offers.map(classify) };
}

/** The per-reply file: one email with everything behind it. It backs BOTH
 *  getReply (the message) and getReplyDebug (the message + its provenance),
 *  which is why the snapshot stores them together. */
async function replyDetail(id: string): Promise<ExtractionDebug & { reply: ResponseRow }> {
  const detail = await load<ExtractionDebug & { reply: ResponseRow }>(replyFile(id));
  return {
    ...detail,
    reply: classifyReply(detail.reply),
    priceRecords: detail.priceRecords.map(classifyRecord),
  };
}

export const api = {
  // --- domains + prices ---
  listDomains: async (): Promise<DomainSummary[]> => {
    const rows = await load<DomainSummary[]>('domains.json');
    return rows.map((d) => ({ ...d, cells: (d.cells ?? []).map(classify) }));
  },

  getDomain: async (domain: string): Promise<DomainDetail> => {
    const detail = await load<DomainDetail>(domainFile(domain));
    return {
      ...detail,
      sheet: {
        ...detail.sheet,
        cells: detail.sheet.cells.map(classify),
        specials: detail.sheet.specials.map(classify),
      },
      history: detail.history.map(classifyRecord),
    };
  },

  // --- replies ---
  listResponses: async (batchId?: string): Promise<ResponseRow[]> => {
    const rows = await load<ResponseRow[]>('responses.json');
    const classified = rows.map(classifyReply);
    return batchId ? classified.filter((r) => r.batchId === batchId) : classified;
  },

  getReply: async (id: string): Promise<ResponseRow> => (await replyDetail(id)).reply,
  getReplyDebug: (id: string): Promise<ExtractionDebug> => replyDetail(id),

  // --- taxonomy + batches ---
  listNiches: async (): Promise<Niche[]> => (await load<Niche[]>('niches.json')).map(classifyNiche),
  listBatches: (): Promise<BatchRow[]> => load<BatchRow[]>('batches.json'),

  // --- everything that writes ---
  addExclusion: () => readOnly('Excluding a domain'),
  deleteExclusion: () => readOnly('Re-including a domain'),
  patchReply: () => readOnly('Editing an extraction'),
  deleteReply: () => readOnly('Deleting a reply'),
  getTargetThread: () => readOnly('The send history'),
};
