// Shared by the CLI-backed providers: the directory an agent CLI is started in.
// Never the repo. `claude -p` auto-loads CLAUDE.md (and the project's .claude/)
// from its working directory and every parent, so starting it in the repo would
// splice our coding notes into every extraction prompt — changing results
// without moving the prompt hash.
//
// Under os.tmpdir(), which is per-user on macOS and private to the unit on the
// VPS (PrivateTmp=true), so nobody else can plant a CLAUDE.md in it or above it.
// One fixed path rather than one per call: the CLI files each session under
// ~/.claude/projects/<cwd>, and a fresh cwd per extraction would leave a
// directory there for every reply ever read.

import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Not guaranteed empty: MCP servers the CLI starts from the user's own config
// write their logs to the cwd (firebase-debug.log). Harmless — what matters is
// that no project instructions live here.

let ready: Promise<string> | undefined;

/** Create (once) and return the private directory agent CLIs run in. */
export function neutralCwd(): Promise<string> {
  const dir = join(tmpdir(), 'adscout-llm-cwd');
  ready ??= mkdir(dir, { recursive: true, mode: 0o700 }).then(
    () => dir,
    (err) => {
      ready = undefined; // let the next call retry rather than cache the failure
      throw err;
    },
  );
  return ready;
}
