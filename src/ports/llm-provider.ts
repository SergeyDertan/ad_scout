// LLM port. Drafting is template-based (no LLM); the LLM is used for reply
// extraction. Implementations: dummy (default, deterministic), ollama, openai,
// claude. The factory wires the concrete one.

import type { JsonSchema } from '../domain/types';

export interface LlmJsonRequest {
  system?: string;
  prompt: string;
  schema: JsonSchema;
  temperature?: number; // ~0.1 for extraction
}

export interface LlmTextRequest {
  system?: string;
  prompt: string;
  temperature?: number;
}

export interface LlmProvider {
  /** Short identifier for logging (e.g. "dummy", "ollama", "openai", "claude"). */
  readonly name: string;
  /** Return a JSON object conforming to `schema`. Throws on hard failure. */
  generateJson(req: LlmJsonRequest): Promise<unknown>;
  /** Free-form text (used later for the optional personalization line). */
  generateText(req: LlmTextRequest): Promise<string>;
}
