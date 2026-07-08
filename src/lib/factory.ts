// The ONLY place that knows the concrete adapters. Wiring is driven by config.

import type { Config } from '../config';
import { DummyEmailProvider } from '../adapters/email/dummy.provider';
import { SmtpImapProvider } from '../adapters/email/smtp-imap.provider';
import { GmailApiProvider, type GmailOAuthHandler } from '../adapters/email/gmail-api.provider';
import { RoutingEmailProvider } from '../adapters/email/routing.provider';
import { DummyLlmProvider } from '../adapters/llm/dummy.provider';
import { OllamaLlmProvider } from '../adapters/llm/ollama.provider';
import { OpenAiLlmProvider } from '../adapters/llm/openai.provider';
import { ClaudeLlmProvider } from '../adapters/llm/claude.provider';
import { ClaudeCodeLlmProvider } from '../adapters/llm/claude-code.provider';
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

export function buildLlm(config: Config): LlmProvider {
  switch (config.llm) {
    case 'ollama':
      return new OllamaLlmProvider(config.ollama);
    case 'openai':
      return new OpenAiLlmProvider(config.openai);
    case 'claude':
      return new ClaudeLlmProvider(config.claude);
    case 'claude-code':
      return new ClaudeCodeLlmProvider(config.claudeCode);
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
  /** Present when Google OAuth credentials are configured (client_secret.json or env vars). */
  gmailOAuth?: GmailOAuthHandler;
}

export function buildAgent(config: Config): Agent {
  const store = buildStore(config);
  const llm = buildLlm(config);

  let email: EmailProvider;
  let gmailOAuth: GmailOAuthHandler | undefined;

  const { clientId, clientSecret } = config.googleOAuth;
  if (clientId && clientSecret) {
    const gmailApi = new GmailApiProvider(store, clientId, clientSecret);
    gmailOAuth = gmailApi;

    if (config.dummyEmail) {
      email = new DummyEmailProvider();
    } else {
      email = new RoutingEmailProvider(new SmtpImapProvider(), gmailApi);
    }
  } else if (config.dummyEmail) {
    email = new DummyEmailProvider();
  } else {
    email = new SmtpImapProvider();
  }

  return { store, email, llm, extractor: new Extractor(llm), gmailOAuth };
}
