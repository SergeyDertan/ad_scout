// Reply extractor: the LLM does NLP (niche tagging, can-post, opt-out, verbatim
// answers); the pure domain code (assembleResult / reconcileOffers) types each
// answer and reconciles niches against the learned registry. Driven by
// inquiryFields — the same source of truth the drafter uses.

import {
  assembleResult,
  buildExtractionSchema,
  type RawExtraction,
} from '../domain/extraction';
import { allNiches, categorizeTopic } from '../domain/niches';
import type { Campaign, Niche, OutreachResult } from '../domain/types';
import type { LlmProvider } from '../ports/llm-provider';

const SYSTEM = [
  "You extract structured information from a website owner's email reply to a cold",
  'outreach about publishing a paid post. Output ONLY JSON matching the provided schema.',
  '',
  'GOAL: capture as much pricing/willingness info as the email contains. Publishers often',
  'send a full price list — extract ONE offer per post type they mention.',
  '',
  'Each offer is tagged with a niche `category`. Rules for tagging:',
  '- Prefer a key from the KNOWN NICHES list below when the owner\'s wording matches it.',
  '- If the owner names a niche not in the list, create a new lowercase_snake_case key and',
  '  a readable label (e.g. "short-term loans" → key "short_term_loans"), and set sensitive',
  '  appropriately. It will be remembered for next time.',
  '- ALWAYS include a "regular" offer when a standard/normal/ordinary post price is given,',
  '  even if we never asked about it.',
  '',
  'STAY LITERAL — do NOT generalize or specialize a niche the owner did not name:',
  '- We ask about "casino" and they reply "casino $50" (or just "$50" answering our casino',
  '  question) → category "casino", price "$50". Do NOT relabel it "sensitive".',
  '- They reply "sensitive posts $40" → category "sensitive", price "$40". Do NOT split it',
  '  into casino/vpn/etc. (The umbrella covers them; that is handled downstream.)',
  '- Only use category "sensitive" when the owner literally uses a generic grey-niche term',
  '  ("sensitive", "special", "grey niche") without naming a specific vertical.',
  '',
  'For each offer:',
  '- canPost: "yes" will publish this type, "no" declines it, "maybe" if unclear/conditional.',
  '- priceRaw: price for this type EXACTLY as written (e.g. "$150", "150 EUR/post"), or "" if',
  '  not stated. Keep digits as digits; never convert or invent numbers.',
  '- sensitive: true for grey niches (casino, gambling, betting, vpn, crypto, cbd, adult,',
  '  dating, forex, loans, pharma, ...); false for ordinary/regular posts.',
  '',
  'Other rules:',
  '- reasoning: ONE short line (max ~20 words) explaining the niche/price classification,',
  '  e.g. "Owner priced casino $150 and regular $60; no other niches mentioned". No line breaks.',
  '- optOut: true ONLY if they ask to stop being contacted / unsubscribe / "remove me".',
  '- fields: answer each listed question with the owner\'s words in "raw" as PLAIN TEXT —',
  '  no markdown, no backslash escapes, no bullet formatting. Empty string "" if a',
  '  question is not addressed. Never guess or infer anything not present in the reply.',
  '- Consider ONLY the owner\'s new reply; ignore any quoted text from our original email',
  '  below it (">"-prefixed lines, "On … wrote:" blocks, forwarded headers).',
  '- Replies may be in any language; still classify canPost/optOut correctly and keep',
  '  priceRaw and raw answers verbatim in the original language.',
  '- conditions: caveats they attach (min word count, dofollow limits, banned niches).',
  '  notes: anything else useful. Both plain text.',
].join('\n');

export interface ExtractionOutcome {
  result: OutreachResult;
  /** Niches seen for the first time in this reply — the caller should persist them. */
  discovered: Niche[];
}

export class Extractor {
  constructor(private readonly llm: LlmProvider) {}

  /**
   * @param knownNiches learned niches from the store (seed niches are merged in
   *   automatically). Pass [] if none are persisted yet.
   */
  async extract(
    campaign: Campaign,
    replyText: string,
    knownNiches: Niche[] = [],
  ): Promise<ExtractionOutcome> {
    const niches = allNiches(knownNiches);
    const schema = buildExtractionSchema(campaign.inquiryFields);
    const fieldList = campaign.inquiryFields
      .map((f) => `- ${f.key}: ${f.question}`)
      .join('\n');
    const nicheList = niches
      .map((n) => `- ${n.key}${n.sensitive ? ' (sensitive)' : ''}: ${n.label} — e.g. ${n.aliases.slice(0, 4).join(', ')}`)
      .join('\n');
    // Strip markdown formatting so the LLM never sees (and copies) escape sequences
    // like \- into JSON string values, which produces invalid JSON.
    const plainText = replyText
      .replace(/\*\*?([^*]+)\*\*?/g, '$1')   // **bold** / *italic*
      .replace(/\\([^\n])/g, '$1');            // \- \* \[ etc → bare character
    const prompt = [
      `Campaign: publishing ${campaign.format} about ${campaign.topic} (${campaign.advertised.url}).`,
      `The niche we asked about: "${campaign.topic}".`,
      '',
      'KNOWN NICHES (reuse these keys when they fit):',
      nicheList,
      '',
      'Questions we asked:',
      fieldList,
      '',
      'The reply to analyze (between the markers):',
      '--- REPLY START ---',
      plainText,
      '--- REPLY END ---',
    ].join('\n');

    const json = await this.llm.generateJson({ system: SYSTEM, prompt, schema, temperature: 0.1 });
    const requestedCategory = categorizeTopic(campaign.topic, niches);
    return assembleResult(campaign.inquiryFields, json as RawExtraction, {
      niches,
      requestedCategory,
    });
  }
}
