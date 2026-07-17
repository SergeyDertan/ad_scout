// DummyLlmProvider — deterministic, no network. The default provider so the
// whole pipeline runs and is testable without Ollama/OpenAI/Claude. It returns
// a schema-valid object by synthesizing values from the JSON Schema itself.

import type { JsonSchema } from '../../domain/types';
import type { LlmJsonRequest, LlmProvider, LlmTextRequest } from '../../ports/llm-provider';

/** Produce a deterministic value satisfying a (subset of) JSON Schema. */
export function synthesizeFromSchema(schema: JsonSchema): unknown {
  const enumVals = schema['enum'];
  if (Array.isArray(enumVals) && enumVals.length > 0) return enumVals[0];

  switch (schema['type']) {
    case 'string':
      return '';
    case 'boolean':
      return false;
    case 'number':
    case 'integer':
      return 0;
    case 'array':
      return [];
    case 'object': {
      const props = (schema['properties'] as Record<string, JsonSchema>) ?? {};
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(props)) {
        out[key] = synthesizeFromSchema(props[key] ?? { type: 'string' });
      }
      return out;
    }
    default:
      return null;
  }
}

export class DummyLlmProvider implements LlmProvider {
  readonly name = 'dummy';

  async generateJson(req: LlmJsonRequest): Promise<unknown> {
    return synthesizeFromSchema(req.schema);
  }

  async generateText(_req: LlmTextRequest): Promise<string> {
    return '(stubbed text from DummyLlmProvider)';
  }
}
