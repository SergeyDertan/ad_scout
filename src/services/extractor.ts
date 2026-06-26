// Reply extractor: the LLM does NLP (can-post, opt-out, verbatim answers); the
// pure domain code (assembleResult) types each answer. Driven by inquiryFields
// — the same source of truth the drafter uses.

import {
  assembleResult,
  buildExtractionSchema,
  type RawExtraction,
} from '../domain/extraction';
import type { Campaign, OutreachResult } from '../domain/types';
import type { LlmProvider } from '../ports/llm-provider';

const SYSTEM = [
  'You extract structured information from a website owner\'s email reply to an',
  'advertising/publishing outreach. Output ONLY JSON matching the provided schema.',
  '- canPost: "yes" if they will publish, "no" if they decline, "maybe" if unclear/conditional.',
  '- optOut: true ONLY if they ask to stop being contacted / unsubscribe.',
  '- For each field, put the owner\'s answer in "raw" as PLAIN TEXT — no markdown, no backslash escapes, no bullet formatting. Preserve numbers and punctuation.',
  '- conditions: any conditions/caveats they mention (plain text). notes: anything else useful (plain text).',
].join('\n');

export class Extractor {
  constructor(private readonly llm: LlmProvider) {}

  async extract(campaign: Campaign, replyText: string): Promise<OutreachResult> {
    const schema = buildExtractionSchema(campaign.inquiryFields);
    const fieldList = campaign.inquiryFields
      .map((f) => `- ${f.key}: ${f.question}`)
      .join('\n');
    // Strip markdown formatting so the LLM never sees (and copies) escape sequences
    // like \- into JSON string values, which produces invalid JSON.
    const plainText = replyText
      .replace(/\*\*?([^*]+)\*\*?/g, '$1')   // **bold** / *italic*
      .replace(/\\([^\n])/g, '$1');            // \- \* \[ etc → bare character
    const prompt = [
      `Campaign: publishing ${campaign.format} about ${campaign.topic} (${campaign.advertised.url}).`,
      'Questions we asked:',
      fieldList,
      '',
      'The reply to analyze (between the markers):',
      '--- REPLY START ---',
      plainText,
      '--- REPLY END ---',
    ].join('\n');

    const json = await this.llm.generateJson({ system: SYSTEM, prompt, schema, temperature: 0.1 });
    return assembleResult(campaign.inquiryFields, json as RawExtraction);
  }
}
