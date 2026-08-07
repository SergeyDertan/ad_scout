// Shared by the CLI-backed providers (claude-code, antigravity): an attachment
// only reaches an agentic model as a FILE on disk that its Read tool can open.

import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { LlmAttachment } from '../../ports/llm-provider';

/** Write attachments into `dir` with sanitized, collision-free names and return
 *  their absolute paths. basename() + the whitelist strip any path traversal. */
export async function stageAttachments(dir: string, attachments: LlmAttachment[]): Promise<string[]> {
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
