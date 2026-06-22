// The ONLY place that knows the concrete adapters. Wiring is driven by config.

import type { Config } from '../config';
import { DummyEmailProvider } from '../adapters/email/dummy.provider';
import { SmtpImapProvider } from '../adapters/email/smtp-imap.provider';
import { DummyLlmProvider } from '../adapters/llm/dummy.provider';
import { OllamaLlmProvider } from '../adapters/llm/ollama.provider';
import { OpenAiLlmProvider } from '../adapters/llm/openai.provider';
import { ClaudeLlmProvider } from '../adapters/llm/claude.provider';
import { MemoryStore } from '../adapters/store/memory.store';
import { PouchDbStore } from '../adapters/store/pouchdb.store';
import type { EmailProvider } from '../ports/email-provider';
import type { LlmProvider } from '../ports/llm-provider';
import type { Store } from '../ports/store';
import { Extractor } from '../services/extractor';

export function buildStore(config: Config): Store {
  switch (config.store) {
    case 'pouchdb':
      return new PouchDbStore(config.pouchDir);
    case 'memory':
    default:
      return new MemoryStore();
  }
}

export function buildEmail(config: Config): EmailProvider {
  switch (config.email) {
    case 'smtp-imap':
      return new SmtpImapProvider();
    case 'dummy':
    default:
      return new DummyEmailProvider();
  }
}

export function buildLlm(config: Config): LlmProvider {
  switch (config.llm) {
    case 'ollama':
      return new OllamaLlmProvider(config.ollama);
    case 'openai':
      return new OpenAiLlmProvider(config.openai);
    case 'claude':
      return new ClaudeLlmProvider(config.claude);
    case 'dummy':
    default:
      return new DummyLlmProvider();
  }
}

export interface Agent {
  store: Store;
  email: EmailProvider;
  llm: LlmProvider;
  extractor: Extractor;
}

export function buildAgent(config: Config): Agent {
  const store = buildStore(config);
  const email = buildEmail(config);
  const llm = buildLlm(config);
  return { store, email, llm, extractor: new Extractor(llm) };
}
