// ClaudeLlmProvider — real implementation via the official Anthropic SDK
// (@anthropic-ai/sdk), structured JSON via output_config.format (per the
// claude-api skill). The SDK is loaded lazily so the core project builds and
// runs without the package installed; to use this provider:
//
//     pnpm add @anthropic-ai/sdk
//     LLM_PROVIDER=claude  ANTHROPIC_API_KEY=sk-ant-...
//
// Model defaults to claude-opus-4-8 (override with CLAUDE_MODEL). Extraction is
// a simple, schema-constrained task, so thinking is omitted (allowed on Opus
// 4.8) for low latency; raise to adaptive thinking if accuracy needs it.

import type { LlmJsonRequest, LlmProvider, LlmTextRequest } from '../../ports/llm-provider';

interface ClaudeOptions {
  apiKey: string;
  model: string;
  maxTokens?: number;
}

// Minimal structural type for the bits of the SDK we touch (boundary is `any`).
interface AnthropicLike {
  messages: {
    create(body: Record<string, unknown>): Promise<{ content?: Array<{ type: string; text?: string }> }>;
  };
}

export class ClaudeLlmProvider implements LlmProvider {
  readonly name = 'claude';
  get model(): string { return this.opts.model; }
  private client?: AnthropicLike;

  constructor(private readonly opts: ClaudeOptions) {}

  private async getClient(): Promise<AnthropicLike> {
    if (this.client) return this.client;
    if (!this.opts.apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
    // Lazy, dynamic import so the package is only required when this provider
    // is actually selected. `as string` keeps it out of compile-time resolution.
    const mod: any = await import('@anthropic-ai/sdk' as string);
    const Anthropic = mod.default ?? mod.Anthropic;
    this.client = new Anthropic({ apiKey: this.opts.apiKey }) as AnthropicLike;
    return this.client;
  }

  private firstText(content?: Array<{ type: string; text?: string }>): string {
    const block = content?.find((b) => b.type === 'text');
    return block?.text ?? '';
  }

  async generateJson(req: LlmJsonRequest): Promise<unknown> {
    const client = await this.getClient();
    const res = await client.messages.create({
      model: this.opts.model,
      max_tokens: this.opts.maxTokens ?? 4096,
      ...(req.system ? { system: req.system } : {}),
      messages: [{ role: 'user', content: req.prompt }],
      output_config: { format: { type: 'json_schema', schema: req.schema } },
    });
    return JSON.parse(this.firstText(res.content));
  }

  async generateText(req: LlmTextRequest): Promise<string> {
    const client = await this.getClient();
    const res = await client.messages.create({
      model: this.opts.model,
      max_tokens: this.opts.maxTokens ?? 4096,
      ...(req.system ? { system: req.system } : {}),
      messages: [{ role: 'user', content: req.prompt }],
    });
    return this.firstText(res.content);
  }
}
