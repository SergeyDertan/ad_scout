import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { Extractor } from './extractor';
import type { LlmJsonRequest, LlmProvider, LlmTextRequest } from '../ports/llm-provider';
import type { Campaign, EmailAttachment } from '../domain/types';

// A spy LLM that records the last generateJson request and returns a minimal
// valid RawExtraction so assembleResult doesn't throw.
class SpyLlm implements LlmProvider {
  readonly name = 'spy';
  last?: LlmJsonRequest;
  constructor(readonly supportsResearch: boolean) {}
  async generateJson(req: LlmJsonRequest): Promise<unknown> {
    this.last = req;
    return {
      optOut: false,
      offers: [{ category: 'regular', label: 'Regular', sensitive: false, canPost: 'yes', priceRaw: '' }],
      reasoning: 'test',
      conditions: '',
      notes: '',
      fields: { price: { raw: '' } },
    };
  }
  async generateText(_req: LlmTextRequest): Promise<string> {
    return '';
  }
}

const campaign: Campaign = {
  id: 'c1',
  name: 'Test',
  advertised: { url: 'https://advertiser.example', description: 'x' },
  topic: 'casino',
  format: 'guest post',
  inquiryFields: [{ key: 'price', question: 'What is the price?', type: 'price' }],
  createdAt: '2026-01-01T00:00:00.000Z',
};

const pdf: EmailAttachment = {
  filename: 'rates.pdf',
  mimeType: 'application/pdf',
  size: 3,
  contentBase64: Buffer.from('abc').toString('base64'),
};

test('research-capable provider gets attachments + webfetch when reply has a link and a file', async () => {
  const llm = new SpyLlm(true);
  await new Extractor(llm).extract(campaign, 'prices here: https://site.example/rates', [], [pdf]);
  assert.equal(llm.last?.allowWebFetch, true);
  assert.equal(llm.last?.attachments?.length, 1);
  assert.equal(llm.last?.attachments?.[0]?.filename, 'rates.pdf');
  assert.match(llm.last?.prompt ?? '', /RESEARCH/);
});

test('no link in the reply → WebFetch stays off', async () => {
  const llm = new SpyLlm(true);
  await new Extractor(llm).extract(campaign, 'we can do $50 per post', [], []);
  assert.equal(llm.last?.allowWebFetch, undefined);
  assert.equal(llm.last?.attachments, undefined);
  assert.doesNotMatch(llm.last?.prompt ?? '', /RESEARCH/);
});

test('non-research provider never receives attachments or webfetch', async () => {
  const llm = new SpyLlm(false);
  await new Extractor(llm).extract(campaign, 'prices: https://site.example/rates', [], [pdf]);
  assert.equal(llm.last?.allowWebFetch, undefined);
  assert.equal(llm.last?.attachments, undefined);
  assert.doesNotMatch(llm.last?.prompt ?? '', /RESEARCH/);
});

// A fetch stub returning a valid (%PDF-prefixed) body for a .pdf link.
function pdfFetch(): typeof fetch {
  return (async () => {
    const body = Buffer.from('%PDF-1.4\n' + 'x'.repeat(20));
    return {
      ok: true,
      async arrayBuffer() {
        return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

test('a .pdf link is downloaded and passed as an attachment, not WebFetch', async () => {
  const llm = new SpyLlm(true);
  let fetched: string | undefined;
  const stub = ((url: string) => {
    fetched = url;
    return pdfFetch()(url);
  }) as unknown as typeof fetch;
  await new Extractor(llm, stub).extract(
    campaign,
    'Our rates are in this PDF: https://pub.example/rates%20list.pdf thanks!',
    [],
    [],
  );
  assert.equal(fetched, 'https://pub.example/rates%20list.pdf');
  assert.equal(llm.last?.allowWebFetch, undefined); // PDF handled via Read, not WebFetch
  assert.equal(llm.last?.attachments?.length, 1);
  assert.equal(llm.last?.attachments?.[0]?.mimeType, 'application/pdf');
  assert.equal(llm.last?.attachments?.[0]?.filename, 'rates list.pdf');
});

test('a failed PDF download is flagged for review, not silently WebFetched', async () => {
  const llm = new SpyLlm(true);
  const failing = (async () => {
    throw new Error('network down');
  }) as unknown as typeof fetch;
  const out = await new Extractor(llm, failing).extract(
    campaign,
    'PDF: https://pub.example/rates.pdf',
    [],
    [],
  );
  assert.equal(llm.last?.allowWebFetch, undefined);
  assert.equal(llm.last?.attachments, undefined);
  assert.equal(out.review.length, 1);
  assert.match(out.review[0], /could not download linked pdf/i);
});

test('non-PDF bytes at a .pdf URL are rejected (magic-byte check) and flagged', async () => {
  const llm = new SpyLlm(true);
  const htmlAtPdfUrl = (async () => ({
    ok: true,
    async arrayBuffer() {
      return Buffer.from('<html>not a pdf</html>').buffer;
    },
  })) as unknown as typeof fetch;
  const out = await new Extractor(llm, htmlAtPdfUrl).extract(
    campaign,
    'PDF: https://pub.example/fake.pdf',
    [],
    [],
  );
  assert.equal(llm.last?.attachments, undefined);
  assert.equal(out.review.length, 1);
  assert.match(out.review[0], /could not download linked pdf/i);
});

test('an unreadable attachment type is flagged for review', async () => {
  const llm = new SpyLlm(true);
  const xlsx = {
    filename: 'rates.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: 3,
    contentBase64: Buffer.from('abc').toString('base64'),
  };
  const out = await new Extractor(llm).extract(campaign, 'see attached', [], [xlsx]);
  assert.equal(llm.last?.attachments, undefined); // not sent to the model
  assert.equal(out.review.length, 1);
  assert.match(out.review[0], /unsupported attachment type/i);
});

test('a non-research provider flags external content it cannot reach', async () => {
  const llm = new SpyLlm(false);
  const out = await new Extractor(llm).extract(
    campaign,
    'rates: https://pub.example/list.pdf',
    [],
    [pdf],
  );
  assert.equal(out.review.length, 2); // the attachment + the link
});
