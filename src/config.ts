// Central config, loaded from the environment (.env). No secrets are stored on
// entities — Account.credentialRef names the env vars holding the secret.

import { readFileSync } from 'node:fs';
import type { WarmupConfig } from './domain/warmup';
import { DEFAULT_WARMUP } from './domain/warmup';
import type { HealthConfig } from './domain/health';
import { DEFAULT_HEALTH } from './domain/health';
import type { PitchProfile } from './domain/types';

export type LlmProviderKind = 'dummy' | 'ollama' | 'openai' | 'claude' | 'claude-code' | 'antigravity';
export type StoreKind = 'memory' | 'pouchdb';

export interface Config {
  dataDir: string;
  lockPath: string;
  llm: LlmProviderKind;
  dummyEmail: boolean;
  store: StoreKind;
  pouchDir: string;
  ollama: { baseUrl: string; model: string };
  openai: { apiKey: string; model: string };
  claude: { apiKey: string; model: string };
  claudeCode: { model: string; timeoutMs: number };
  antigravity: { model: string; timeoutMs: number };
  googleOAuth: { clientId: string; clientSecret: string };
  sendWindow: { startHour: number; endHour: number; paceEndHour: number };
  /** Global outreach pitch defaults. A Batch may override `advertised` per import;
   *  everything else is global. Drives both the drafter and the extractor. */
  pitch: PitchProfile;
  /** No-reply follow-up policy (global). */
  followUp: { afterDays: number; maxFollowUps: number };
  /** No-reply follow-up bumps. Disabled for now — set FOLLOW_UPS_ENABLED=true to
   *  re-enable. The follow-up code stays intact; this only gates the queue. */
  followUpsEnabled: boolean;
  reconcileGraceMs: number;
  warmup: WarmupConfig;
  health: HealthConfig;
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function envBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const v = env[name];
  if (v == null) return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

function loadGoogleOAuth(env: NodeJS.ProcessEnv): { clientId: string; clientSecret: string } {
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
  }
  // Fallback: parse client_secret.json from GOOGLE_CLIENT_SECRET_PATH or ./client_secret.json
  const path = env.GOOGLE_CLIENT_SECRET_PATH ?? './client_secret.json';
  try {
    const json = readFileSync(path, 'utf8');
    const data = JSON.parse(json) as Record<string, unknown>;
    const installed = (data['installed'] ?? data['web']) as Record<string, string> | undefined;
    if (installed?.['client_id'] && installed?.['client_secret']) {
      return { clientId: installed['client_id'], clientSecret: installed['client_secret'] };
    }
  } catch {
    // File not found or invalid — Google OAuth simply not configured.
  }
  return { clientId: '', clientSecret: '' };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = env.DATA_DIR ?? './data';
  return {
    dataDir,
    lockPath: `${dataDir}/agent.lock`,
    llm: (env.LLM_PROVIDER as LlmProviderKind) ?? 'dummy',
    dummyEmail: !env.EMAIL_PROVIDER || env.EMAIL_PROVIDER === 'dummy',
    store: (env.STORE as StoreKind) ?? 'memory',
    pouchDir: env.POUCH_DIR ?? `${dataDir}/pouch`,
    ollama: {
      baseUrl: env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
      model: env.OLLAMA_MODEL ?? 'gemma4:26b-mlx',
    },
    openai: {
      apiKey: env.OPENAI_API_KEY ?? '',
      model: env.OPENAI_MODEL ?? 'gpt-4o-mini',
    },
    claude: {
      apiKey: env.ANTHROPIC_API_KEY ?? '',
      model: env.CLAUDE_MODEL ?? 'claude-opus-4-8',
    },
    claudeCode: {
      // An EXACT id, not the 'sonnet' alias: the alias silently moves to a new
      // model, and every extraction records this string as its provenance. A
      // stored price has to stay traceable to the model that actually read it.
      model: env.CLAUDE_CODE_MODEL ?? 'claude-sonnet-5',
      timeoutMs: envInt('CLAUDE_CODE_TIMEOUT_MS', 120_000),
    },
    antigravity: {
      model: env.AGY_MODEL ?? 'gemini-3.1-pro-high',
      timeoutMs: envInt('AGY_TIMEOUT_MS', 120_000),
    },
    googleOAuth: loadGoogleOAuth(env),
    sendWindow: (() => {
      const startHour = envInt('SEND_WINDOW_START_HOUR', 9);
      const endHour = envInt('SEND_WINDOW_END_HOUR', 18);
      // Soft pacing target: aim to finish ~1h before the hard close, leaving a
      // tail buffer. Clamped to (startHour, endHour] so it's always sane.
      const paceEndHour = clampInt(
        envInt('SEND_WINDOW_PACE_END_HOUR', endHour - 1),
        startHour + 1,
        endHour,
      );
      return { startHour, endHour, paceEndHour };
    })(),
    pitch: {
      advertised: {
        url: env.ADVERTISED_URL ?? 'casinoslists.com',
        description: env.ADVERTISED_DESCRIPTION ?? 'a rapidly growing online casino platform',
      },
      topic: env.PITCH_TOPIC ?? 'casino',
      format: env.PITCH_FORMAT ?? 'article',
      ...(env.SUBJECT_TEMPLATE ? { subjectTemplate: env.SUBJECT_TEMPLATE } : {}),
    },
    followUp: {
      afterDays: envInt('FOLLOW_UP_AFTER_DAYS', 4),
      maxFollowUps: envInt('FOLLOW_UP_MAX', 2),
    },
    followUpsEnabled: envBool(env, 'FOLLOW_UPS_ENABLED', false),
    reconcileGraceMs: envInt('RECONCILE_GRACE_MS', 15 * 60_000),
    warmup: DEFAULT_WARMUP,
    health: DEFAULT_HEALTH,
  };
}
