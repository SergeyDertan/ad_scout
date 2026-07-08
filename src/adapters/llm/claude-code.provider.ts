// ClaudeCodeLlmProvider — shells out to the locally installed `claude` CLI
// (Claude Code) in headless/print mode, so extraction runs against the
// machine's logged-in Claude subscription (Pro/Max) usage allowance instead
// of per-token API billing or a local Ollama model. Useful when volume is
// low and latency isn't critical (this project's poll-pass extraction).
//
//     LLM_PROVIDER=claude-code  CLAUDE_CODE_MODEL=sonnet   (or opus/haiku/full id)
//
// Requires `claude` on PATH, logged in via `claude login` (not an API key —
// ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN are stripped from the child env
// below, since either would silently switch the CLI to pay-per-token API
// billing instead of the subscription session). `--allowedTools ''` strips
// every tool (Bash/Read/Write/...) from the session so this is a pure
// text-in/JSON-out completion with no filesystem or shell side effects.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { LlmJsonRequest, LlmProvider, LlmTextRequest } from '../../ports/llm-provider';
import { logger } from '../../lib/logger';

const execFileAsync = promisify(execFile);

interface ClaudeCodeOptions {
  /** Model alias ("sonnet" | "opus" | "haiku") or a full model id. */
  model: string;
  timeoutMs?: number;
}

interface ClaudeCliResult {
  is_error: boolean;
  result: string;
  structured_output?: unknown;
  total_cost_usd?: number;
}

export class ClaudeCodeLlmProvider implements LlmProvider {
  readonly name = 'claude-code';

  constructor(private readonly opts: ClaudeCodeOptions) {}

  private async run(args: string[], label: string): Promise<ClaudeCliResult> {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;

    const t0 = Date.now();
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync('claude', args, {
        env,
        timeout: this.opts.timeoutMs ?? 120_000,
        maxBuffer: 16 * 1024 * 1024,
      }));
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string };
      logger.warn('claude-code exec failed', {
        label,
        elapsedMs: Date.now() - t0,
        error: e.message,
        stderr: e.stderr?.slice(0, 2000),
      });
      throw new Error(`claude CLI failed (${label}): ${e.message}`);
    }
    const elapsedMs = Date.now() - t0;

    let parsed: ClaudeCliResult;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      logger.warn('claude-code stdout not JSON', { label, raw: stdout.slice(0, 2000) });
      throw new Error(`claude CLI (${label}) returned non-JSON output`);
    }
    logger.info('claude-code call complete', {
      label,
      model: this.opts.model,
      elapsedMs,
      costUsd: parsed.total_cost_usd,
    });
    if (parsed.is_error) {
      throw new Error(`claude CLI (${label}) reported an error: ${parsed.result}`);
    }
    return parsed;
  }

  async generateJson(req: LlmJsonRequest): Promise<unknown> {
    const args = [
      '-p',
      req.prompt,
      '--output-format',
      'json',
      '--model',
      this.opts.model,
      '--allowedTools',
      '',
      '--permission-mode',
      'dontAsk',
      '--json-schema',
      JSON.stringify(req.schema),
      ...(req.system ? ['--append-system-prompt', req.system] : []),
    ];
    const result = await this.run(args, 'generateJson');
    if (result.structured_output !== undefined) return result.structured_output;
    return JSON.parse(result.result);
  }

  async generateText(req: LlmTextRequest): Promise<string> {
    const args = [
      '-p',
      req.prompt,
      '--output-format',
      'json',
      '--model',
      this.opts.model,
      '--allowedTools',
      '',
      '--permission-mode',
      'dontAsk',
      ...(req.system ? ['--append-system-prompt', req.system] : []),
    ];
    const result = await this.run(args, 'generateText');
    return result.result;
  }
}
