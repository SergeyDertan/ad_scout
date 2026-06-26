import type { JsonSchema } from '../../domain/types';
import type { LlmJsonRequest, LlmProvider, LlmTextRequest } from '../../ports/llm-provider';
import { logger } from '../../lib/logger';

interface OllamaOptions {
  baseUrl: string;
  model: string;
}

interface OllamaChatResponse {
  message?: { content?: string };
  eval_duration?: number; // nanoseconds
  load_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

export class OllamaLlmProvider implements LlmProvider {
  readonly name = 'ollama';
  constructor(private readonly opts: OllamaOptions) {}

  private async chat(
    messages: Array<{ role: string; content: string }>,
    format: JsonSchema | undefined,
    temperature: number | undefined,
    label: string,
  ): Promise<string> {
    const promptChars = messages.reduce((n, m) => n + m.content.length, 0);
    logger.info('ollama request', { label, model: this.opts.model, promptChars, structured: !!format });

    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl}/api/chat`, {
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
    } catch (err) {
      logger.warn('ollama fetch error', { label, elapsedMs: Date.now() - t0, error: (err as Error).message });
      throw new Error(`Ollama unreachable at ${this.opts.baseUrl} — is it running? (${(err as Error).message})`);
    }

    const elapsedMs = Date.now() - t0;

    if (!res.ok) {
      const body = await res.text();
      logger.warn('ollama http error', { label, status: res.status, elapsedMs, body });
      throw new Error(`Ollama ${res.status}: ${body}`);
    }

    const data = (await res.json()) as OllamaChatResponse;
    const content = data.message?.content ?? '';
    const tokensOut = data.eval_count ?? null;
    const tokensIn = data.prompt_eval_count ?? null;
    const inferenceMs = data.eval_duration != null ? Math.round(data.eval_duration / 1e6) : null;
    const tokensPerSec =
      tokensOut != null && inferenceMs != null && inferenceMs > 0
        ? Math.round((tokensOut / inferenceMs) * 1000)
        : null;
    logger.info('ollama call complete', {
      label,
      model: this.opts.model,
      elapsedMs,
      inferenceMs,
      tokensIn,
      tokensOut,
      tokensPerSec,
      replyChars: content.length,
    });

    return content;
  }

  async generateJson(req: LlmJsonRequest): Promise<unknown> {
    const messages = [
      ...(req.system ? [{ role: 'system', content: req.system }] : []),
      { role: 'user', content: req.prompt },
    ];
    logger.debug('ollama generateJson prompt', {
      model: this.opts.model,
      system: req.system?.slice(0, 300),
      prompt: req.prompt.slice(0, 500),
    });
    const content = await this.chat(messages, req.schema, req.temperature, 'generateJson');
    const stripped = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    // Remove invalid JSON escape sequences that LLMs emit from markdown formatting.
    // Valid JSON escapes: \" \\ \/ \b \f \n \r \t \uXXXX (exactly 4 hex digits).
    // Pass 1: \u not followed by exactly 4 hex digits → drop the backslash (e.g. \url → url).
    // Pass 2: any other non-standard single-char escape → drop the backslash (e.g. \- → -).
    const sanitized = stripped
      .replace(/\\u(?![0-9a-fA-F]{4})/g, 'u')
      .replace(/\\([^"\\/bfnrtu])/g, (_m, ch: string) => ch);
    try {
      return JSON.parse(sanitized);
    } catch (err) {
      logger.warn('ollama json parse failed', {
        raw: stripped.slice(0, 800),
        sanitized: sanitized.slice(0, 800),
        error: (err as Error).message,
      });
      throw err;
    }
  }

  async generateText(req: LlmTextRequest): Promise<string> {
    const messages = [
      ...(req.system ? [{ role: 'system', content: req.system }] : []),
      { role: 'user', content: req.prompt },
    ];
    logger.debug('ollama generateText prompt', {
      model: this.opts.model,
      system: req.system?.slice(0, 300),
      prompt: req.prompt.slice(0, 500),
    });
    return this.chat(messages, undefined, req.temperature, 'generateText');
  }
}
