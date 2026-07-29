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
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type {
  LlmAttachment,
  LlmJsonRequest,
  LlmProvider,
  LlmTextRequest,
} from '../../ports/llm-provider';
import { detectUsageLimit } from '../../lib/errors';
import { logger } from '../../lib/logger';

const execFileAsync = promisify(execFile);

// Structured JSON extraction can be slow even without tools — a large price
// list (many niche cells) is a lot of constrained output — and slower
// still when the model may use tools (Read/WebFetch) across several turns. Give
// every generateJson call this headroom; pure text completions keep the short default.
const JSON_TIMEOUT_MS = 300_000;

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
  get model(): string { return this.opts.model; }
  readonly supportsResearch = true;

  constructor(private readonly opts: ClaudeCodeOptions) {}

  private async run(args: string[], label: string, timeoutMs?: number): Promise<ClaudeCliResult> {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;

    const t0 = Date.now();
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync('claude', args, {
        env,
        timeout: timeoutMs ?? this.opts.timeoutMs ?? 120_000,
        maxBuffer: 16 * 1024 * 1024,
      }));
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string; killed?: boolean; signal?: string };
      // `claude -p --output-format json` writes its error payload to STDOUT, not
      // stderr — capture both so a non-zero exit is diagnosable (and surface a
      // timeout/kill explicitly rather than as an opaque "Command failed").
      logger.warn('claude-code exec failed', {
        label,
        elapsedMs: Date.now() - t0,
        code: e.code,
        killed: e.killed,
        signal: e.signal,
        error: e.message,
        stderr: e.stderr?.slice(0, 2000),
        stdout: e.stdout?.slice(0, 2000),
      });
      // A subscription usage/session-limit is not a transient failure — surface it
      // as a typed error so the extraction driver can stop and resume later.
      const limit = detectUsageLimit(e.stdout) ?? detectUsageLimit(e.stderr) ?? detectUsageLimit(e.message);
      if (limit) throw limit;
      const detail = e.killed ? `timed out/killed (signal ${e.signal})` : (e.stdout?.trim() || e.stderr?.trim() || e.message);
      throw new Error(`claude CLI failed (${label}): ${detail.slice(0, 500)}`);
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
      const limit = detectUsageLimit(parsed.result);
      if (limit) throw limit;
      throw new Error(`claude CLI (${label}) reported an error: ${parsed.result}`);
    }
    return parsed;
  }

  async generateJson(req: LlmJsonRequest): Promise<unknown> {
    const hasAttachments = !!req.attachments?.length;

    // allowedTools stays '' when no tools are requested — identical to the old
    // pure text-in/JSON-out behavior. Only opt in per-call when the extractor
    // asks for it.
    const allowedTools: string[] = [];
    const extraArgs: string[] = [];
    let prompt = req.prompt;
    let tmpDir: string | undefined;

    if (req.allowWebFetch) allowedTools.push('WebFetch');
    if (hasAttachments) {
      tmpDir = await mkdtemp(join(tmpdir(), 'adscout-att-'));
      const paths = await stageAttachments(tmpDir, req.attachments!);
      // Grep alongside Read: a publisher's price list can be thousands of rows,
      // well past Read's line cap, so the row we need is only findable by search.
      allowedTools.push('Read', 'Grep');
      extraArgs.push('--add-dir', tmpDir);
      prompt = `${prompt}\n\nFILES you may Read/Grep (absolute paths):\n${paths
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
        '--allowedTools',
        allowedTools.join(','),
        '--permission-mode',
        'dontAsk',
        '--json-schema',
        JSON.stringify(req.schema),
        ...extraArgs,
        ...(req.system ? ['--append-system-prompt', req.system] : []),
      ];
      const result = await this.run(args, 'generateJson', JSON_TIMEOUT_MS);
      if (result.structured_output !== undefined) return result.structured_output;
      return JSON.parse(result.result);
    } finally {
      if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
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

/** Write attachments into `dir` with sanitized, collision-free names and return
 *  their absolute paths. basename() + the whitelist strip any path traversal. */
async function stageAttachments(dir: string, attachments: LlmAttachment[]): Promise<string[]> {
  const paths: string[] = [];
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    const clean = basename(att.filename).replace(/[^\w.\- ]/g, '_') || 'file';
    const p = join(dir, `${i + 1}-${clean}`);
    await writeFile(p, att.contentBase64, { encoding: 'base64' });
    paths.push(p);
  }
  return paths;
}
