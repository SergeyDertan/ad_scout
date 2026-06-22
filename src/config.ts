// Central config, loaded from the environment (.env). No secrets are stored on
// entities — Account.credentialRef names the env vars holding the secret.

import type { WarmupConfig } from './domain/warmup';
import { DEFAULT_WARMUP } from './domain/warmup';
import type { HealthConfig } from './domain/health';
import { DEFAULT_HEALTH } from './domain/health';

export type LlmProviderKind = 'dummy' | 'ollama' | 'openai' | 'claude';
export type EmailProviderKind = 'dummy' | 'smtp-imap';
export type StoreKind = 'memory' | 'pouchdb';

export interface Config {
  dataDir: string;
  lockPath: string;
  llm: LlmProviderKind;
  email: EmailProviderKind;
  store: StoreKind;
  pouchDir: string;
  ollama: { baseUrl: string; model: string };
  openai: { apiKey: string; model: string };
  claude: { apiKey: string; model: string };
  sendWindow: { startHour: number; endHour: number };
  reconcileGraceMs: number;
  warmup: WarmupConfig;
  health: HealthConfig;
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = env.DATA_DIR ?? './data';
  return {
    dataDir,
    lockPath: `${dataDir}/agent.lock`,
    llm: (env.LLM_PROVIDER as LlmProviderKind) ?? 'dummy',
    email: (env.EMAIL_PROVIDER as EmailProviderKind) ?? 'dummy',
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
    sendWindow: {
      startHour: envInt('SEND_WINDOW_START_HOUR', 9),
      endHour: envInt('SEND_WINDOW_END_HOUR', 18),
    },
    reconcileGraceMs: envInt('RECONCILE_GRACE_MS', 15 * 60_000),
    warmup: DEFAULT_WARMUP,
    health: DEFAULT_HEALTH,
  };
}
