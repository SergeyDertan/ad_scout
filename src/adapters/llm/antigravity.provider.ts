// AntigravityLlmProvider — shells out to the locally installed `agy` CLI
// (Google Antigravity) in print mode, so extraction runs against the machine's
// Google AI subscription instead of per-token API billing. Same shape as
// ClaudeCodeLlmProvider (see the notes there); this is the Google-side twin.
//
//     LLM_PROVIDER=antigravity  AGY_MODEL=gemini-3.1-pro-high
//
// `agy models` lists what the account can reach — Gemini, plus Anthropic models
// under Antigravity aliases (claude-sonnet-4-6, claude-opus-4-6-thinking).
// Requires `agy` on PATH and logged in.
//
// Differences from the claude CLI that matter here:
//   - No --allowedTools. Tools cannot be stripped, so this is never a "pure"
//     completion; read-only tools are auto-approved in print mode. Only pass
//     attachments/allowWebFetch to a provider you're happy to give that.
//   - No --append-system-prompt: `system` is prepended into the prompt text.
//   - The result envelope reports `status`, not an is_error boolean, and gives
//     token `usage` instead of a dollar cost.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  LlmJsonRequest,
  LlmProvider,
  LlmTextRequest,
} from '../../ports/llm-provider';
import { detectUsageLimit } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { stageAttachments } from './stage-attachments';

const execFileAsync = promisify(execFile);

/** Matches JSON_TIMEOUT_MS in claude-code.provider.ts — same workload. */
const JSON_TIMEOUT_MS = 300_000;

interface AntigravityOptions {
  /** Model id from `agy models`, e.g. "gemini-3.1-pro-high". */
  model: string;
  timeoutMs?: number;
}

interface AgyCliResult {
  status: string; // "SUCCESS" | error status
  response: string;
  structured_output?: unknown;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
}

export class AntigravityLlmProvider implements LlmProvider {
  readonly name = 'antigravity';
  get model(): string { return this.opts.model; }
  readonly supportsResearch = true;

  constructor(private readonly opts: AntigravityOptions) {}

  private async run(args: string[], label: string, timeoutMs?: number): Promise<AgyCliResult> {
    const timeout = timeoutMs ?? this.opts.timeoutMs ?? 120_000;
    const t0 = Date.now();
    let stdout: string;
    try {
      // --print-timeout is the CLI's own wait; keep it just under our kill
      // timeout so we get its JSON error rather than an opaque SIGTERM.
      ({ stdout } = await execFileAsync('agy', [...args, '--print-timeout', `${Math.floor(timeout / 1000) - 5}s`], {
        timeout,
        maxBuffer: 16 * 1024 * 1024,
      }));
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string; killed?: boolean; signal?: string };
      logger.warn('antigravity exec failed', {
        label,
        elapsedMs: Date.now() - t0,
        code: e.code,
        killed: e.killed,
        signal: e.signal,
        error: e.message,
        stderr: e.stderr?.slice(0, 2000),
        stdout: e.stdout?.slice(0, 2000),
      });
      // Not `e.message`: execFile builds it from the command line, echoing the
      // prompt (and the publisher email inside it) back at us — a publisher's own
      // "we've reached our limit" would read as OUR limit and halt the run.
      const limit = detectUsageLimit(e.stdout) ?? detectUsageLimit(e.stderr);
      if (limit) throw limit;
      const detail = e.killed ? `timed out/killed (signal ${e.signal})` : (e.stdout?.trim() || e.stderr?.trim() || e.message);
      throw new Error(`agy CLI failed (${label}): ${detail.slice(0, 500)}`);
    }
    const elapsedMs = Date.now() - t0;

    let parsed: AgyCliResult;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      logger.warn('antigravity stdout not JSON', { label, raw: stdout.slice(0, 2000) });
      throw new Error(`agy CLI (${label}) returned non-JSON output`);
    }
    logger.info('antigravity call complete', {
      label,
      model: this.opts.model,
      elapsedMs,
      tokens: parsed.usage?.total_tokens,
    });
    if (parsed.status !== 'SUCCESS') {
      const limit = detectUsageLimit(parsed.response) ?? detectUsageLimit(parsed.status);
      if (limit) throw limit;
      throw new Error(`agy CLI (${label}) reported status ${parsed.status}: ${(parsed.response ?? '').slice(0, 500)}`);
    }
    return parsed;
  }

  async generateJson(req: LlmJsonRequest): Promise<unknown> {
    const hasAttachments = !!req.attachments?.length;
    const extraArgs: string[] = [];
    let prompt = withSystem(req.system, req.prompt);
    let tmpDir: string | undefined;

    if (hasAttachments) {
      tmpDir = await mkdtemp(join(tmpdir(), 'adscout-att-'));
      const paths = await stageAttachments(tmpDir, req.attachments!);
      extraArgs.push('--add-dir', tmpDir);
      prompt = `${prompt}\n\nFILES you may read (absolute paths):\n${paths
        .map((p) => `- ${p}`)
        .join('\n')}`;
    }

    try {
      const args = [
        '-p',
        prompt,
        '--output-format',
        'json',
        '--model',
        this.opts.model,
        '--disable-slash-commands',
        '--json-schema',
        JSON.stringify(req.schema),
        ...extraArgs,
      ];
      // The CLI intermittently reports SUCCESS with an EMPTY response and no
      // structured_output (measured ~1 call in 5 on one short reply). It is
      // transient, so retry once before giving up — an extraction driver that
      // treats this as a hard failure would litter a batch run with holes.
      for (let attempt = 1; ; attempt++) {
        const result = await this.run(args, 'generateJson', JSON_TIMEOUT_MS);
        if (result.structured_output !== undefined) return result.structured_output;
        // `response` is then a chat answer, often fenced; salvage its JSON if
        // there is any, rather than an opaque JSON.parse throw.
        const salvaged = stripFence(result.response ?? '');
        try {
          return JSON.parse(salvaged);
        } catch {
          logger.warn('antigravity returned no structured_output', {
            model: this.opts.model,
            attempt,
            response: (result.response ?? '').slice(0, 2000),
          });
          if (attempt >= 2) {
            throw new Error(
              `agy CLI (generateJson) returned no structured_output and unparseable text after ${attempt} attempts: ${salvaged.slice(0, 300) || '(empty response)'}`,
            );
          }
        }
      }
    } finally {
      if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async generateText(req: LlmTextRequest): Promise<string> {
    const args = [
      '-p',
      withSystem(req.system, req.prompt),
      '--output-format',
      'json',
      '--model',
      this.opts.model,
      '--disable-slash-commands',
    ];
    const result = await this.run(args, 'generateText');
    return result.response;
  }
}

/** `agy` has no --append-system-prompt, so the system text rides in the prompt. */
function withSystem(system: string | undefined, prompt: string): string {
  return system ? `${system}\n\n---\n\n${prompt}` : prompt;
}

/** Unwrap a ```json fenced block, if the response came back as one. */
function stripFence(text: string): string {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (m ? m[1] : text).trim();
}

