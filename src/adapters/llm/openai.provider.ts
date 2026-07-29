// OpenAiLlmProvider — real implementation against the OpenAI Chat Completions
// API with json_schema structured outputs. Uses built-in fetch (no dependency).
// Enable with LLM_PROVIDER=openai and OPENAI_API_KEY set.

import type { LlmJsonRequest, LlmProvider, LlmTextRequest } from '../../ports/llm-provider';

interface OpenAiOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export class OpenAiLlmProvider implements LlmProvider {
  readonly name = 'openai';
  get model(): string { return this.opts.model; }
  private readonly baseUrl: string;
  constructor(private readonly opts: OpenAiOptions) {
    this.baseUrl = opts.baseUrl ?? 'https://api.openai.com/v1';
  }

  private async chat(body: Record<string, unknown>): Promise<string> {
    if (!this.opts.apiKey) throw new Error('OPENAI_API_KEY is not set');
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as ChatResponse;
    return data.choices?.[0]?.message?.content ?? '';
  }

  async generateJson(req: LlmJsonRequest): Promise<unknown> {
    const content = await this.chat({
      model: this.opts.model,
      temperature: req.temperature ?? 0.1,
      messages: [
        ...(req.system ? [{ role: 'system', content: req.system }] : []),
        { role: 'user', content: req.prompt },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'extraction', strict: true, schema: req.schema },
      },
    });
    return JSON.parse(content);
  }

  async generateText(req: LlmTextRequest): Promise<string> {
    return this.chat({
      model: this.opts.model,
      temperature: req.temperature ?? 0.7,
      messages: [
        ...(req.system ? [{ role: 'system', content: req.system }] : []),
        { role: 'user', content: req.prompt },
      ],
    });
  }
}
