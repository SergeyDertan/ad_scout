// LLM port. Drafting is template-based (no LLM); the LLM is used for reply
// extraction. Implementations: dummy (default, deterministic), ollama, openai,
// claude, claude-code. The factory wires the concrete one.

import type { JsonSchema } from '../domain/types';

/** A file the model may read to complete its answer. Only agentic providers
 *  (claude-code) act on these; others ignore them. */
export interface LlmAttachment {
  filename: string;
  mimeType: string;
  contentBase64: string;
}

export interface LlmJsonRequest {
  system?: string;
  prompt: string;
  schema: JsonSchema;
  temperature?: number; // ~0.1 for extraction
  /** Files the model may open (enables a sandboxed Read tool on claude-code). */
  attachments?: LlmAttachment[];
  /** Allow the model to fetch URLs it finds in the prompt (enables WebFetch on
   *  claude-code). Untrusted input — providers must sandbox/time-box it. */
  allowWebFetch?: boolean;
}

export interface LlmTextRequest {
  system?: string;
  prompt: string;
  temperature?: number;
}

export interface LlmProvider {
  /** Short identifier for logging (e.g. "dummy", "ollama", "openai", "claude"). */
  readonly name: string;
  /** The exact model id this provider is configured with, when it has one
   *  (`dummy` does not). Recorded on every extraction so a stored price can be
   *  traced to the model that produced it — see ExtractionProvenance. */
  readonly model?: string;
  /** True if the provider can act on `attachments` / `allowWebFetch` (i.e. Read
   *  files and WebFetch links). Only claude-code today; others ignore them. */
  readonly supportsResearch?: boolean;
  /** Return a JSON object conforming to `schema`. Throws on hard failure. */
  generateJson(req: LlmJsonRequest): Promise<unknown>;
  /** Free-form text (used later for the optional personalization line). */
  generateText(req: LlmTextRequest): Promise<string>;
}
