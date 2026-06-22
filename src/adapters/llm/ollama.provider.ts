// OllamaLlmProvider — real implementation against a local Ollama server using
// its OpenAI-incompatible native /api/chat endpoint with JSON-schema `format`
// (structured outputs). Uses built-in fetch, so no dependency is required.
//
// Enable by installing/running Ollama and setting LLM_PROVIDER=ollama. Confirm
// the exact model tag at install (candidate: gemma4:26b-mlx).

import type { JsonSchema } from '../../domain/types';
import type { LlmJsonRequest, LlmProvider, LlmTextRequest } from '../../ports/llm-provider';

interface OllamaOptions {
  baseUrl: string;
  model: string;
}

interface OllamaChatResponse {
  message?: { content?: string };
}

export class OllamaLlmProvider implements LlmProvider {
  readonly name = 'ollama';
  constructor(private readonly opts: OllamaOptions) {}

  private async chat(
    messages: Array<{ role: string; content: string }>,
    format: JsonSchema | undefined,
    temperature: number | undefined,
  ): Promise<string> {
    const res = await fetch(`${this.opts.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.opts.model,
        messages,
        stream: false,
        ...(format ? { format } : {}),
        options: { temperature: temperature ?? 0.1 },
      }),
    });
    if (!res.ok) {
      throw new Error(`Ollama ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as OllamaChatResponse;
    return data.message?.content ?? '';
  }

  async generateJson(req: LlmJsonRequest): Promise<unknown> {
    const messages = [
      ...(req.system ? [{ role: 'system', content: req.system }] : []),
      { role: 'user', content: req.prompt },
    ];
    const content = await this.chat(messages, req.schema, req.temperature);
    return JSON.parse(content);
  }

  async generateText(req: LlmTextRequest): Promise<string> {
    const messages = [
      ...(req.system ? [{ role: 'system', content: req.system }] : []),
      { role: 'user', content: req.prompt },
    ];
    return this.chat(messages, undefined, req.temperature);
  }
}
