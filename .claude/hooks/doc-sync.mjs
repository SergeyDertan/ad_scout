#!/usr/bin/env node
// Stop hook: when a turn leaves code changed in an area whose docs/claude note
// did not change, block the stop once and ask Claude to update the note or say
// why none is needed. The rule it enforces is CLAUDE.md → "Keeping these notes
// true"; AREAS below is the same map as the table there — change both together.
//
// Once per change set, not once per turn: the fingerprint of what it flagged is
// remembered in the git dir, so an answered reminder stays answered until the
// flagged code changes again. It never fails the session: any error (not a git
// repo, no HEAD yet, git missing) means "say nothing".

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const AREAS = [
  {
    doc: 'docs/claude/store.md',
    code: [
      /^src\/adapters\/store\//,
      /^src\/ports\/store\.ts$/,
      /^src\/domain\/types\.ts$/,
      /^src\/services\/(read-models|pagination|dump|backup)\.ts$/,
    ],
  },
  {
    doc: 'docs/claude/pipeline.md',
    code: [
      /^src\/pipeline\//,
      /^src\/scheduler\//,
      /^src\/domain\//,
      /^src\/services\/(drafter|extractor|linked-docs|account-selector)\.ts$/,
      /^src\/adapters\/(email|llm)\//,
      /^src\/ports\/(email|llm)-provider\.ts$/,
    ],
  },
  {
    doc: 'docs/claude/server.md',
    code: [
      /^src\/server\//,
      /^src\/(serve|config)\.ts$/,
      /^src\/lib\//,
      /^deploy\//,
      /^\.github\//,
      /^(justfile|\.env\.example|package\.json)$/,
    ],
  },
  {
    doc: 'docs/claude/web.md',
    code: [/^web\/(src\/|vite\.config\.ts$|package\.json$)/],
  },
];

// Tests and fixtures describe behaviour; they never make a note wrong.
const IGNORED = [/\.test\.tsx?$/, /\/__fixtures__\//];

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function lines(text) {
  return text.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** Every path this work touched: uncommitted, untracked, and committed but not pushed. */
function changedFiles(root) {
  const files = new Set([
    ...lines(git(root, ['diff', '--name-only', 'HEAD'])),
    ...lines(git(root, ['ls-files', '--others', '--exclude-standard'])),
  ]);
  try {
    for (const f of lines(git(root, ['diff', '--name-only', '@{upstream}...HEAD']))) files.add(f);
  } catch {
    // No upstream (new branch, detached HEAD) — uncommitted work is still covered.
  }
  return [...files];
}

/** Areas whose code changed while their note did not, with the files responsible. */
function staleAreas(files) {
  const out = [];
  const claimed = new Set();
  for (const area of AREAS) {
    const hits = files.filter(
      (f) => !claimed.has(f) && !IGNORED.some((re) => re.test(f)) && area.code.some((re) => re.test(f)),
    );
    hits.forEach((f) => claimed.add(f)); // first matching area owns a file (domain/types.ts → store)
    if (hits.length > 0 && !files.includes(area.doc)) out.push({ doc: area.doc, files: hits });
  }
  return out;
}

/** Changes whenever the flagged files' content (or the set of them) changes. */
function fingerprint(root, stale) {
  const h = createHash('sha256');
  for (const { doc, files } of stale) {
    h.update(`${doc}\n`);
    for (const f of [...files].sort()) {
      const p = join(root, f);
      h.update(`${f}\n`);
      h.update(existsSync(p) ? readFileSync(p) : 'deleted');
    }
  }
  return h.digest('hex');
}

function main() {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    // No or malformed stdin — carry on with defaults.
  }
  // Claude is already continuing because of a Stop hook: never chain another.
  if (input.stop_hook_active) return;

  const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const stale = staleAreas(changedFiles(root));
  if (stale.length === 0) return;

  const marker = resolve(root, git(root, ['rev-parse', '--git-path', 'claude-doc-sync']).trim());
  const print = fingerprint(root, stale);
  if (existsSync(marker) && readFileSync(marker, 'utf8').trim() === print) return;
  writeFileSync(marker, `${print}\n`);

  const list = stale
    .map(({ doc, files }) => {
      const shown = files.slice(0, 8).join(', ');
      const more = files.length > 8 ? ` (+${files.length - 8} more)` : '';
      return `- ${doc} — code changed: ${shown}${more}`;
    })
    .join('\n');
  const reason = [
    'Doc check (CLAUDE.md → "Keeping these notes true"). Code changed in areas whose note did not:',
    list,
    'If the change affects anything a note describes — a flow, rule, route, command, env var, doc type or gotcha — update that note now.',
    'If it does not, say so in one line and stop. This reminder fires once per change set.',
  ].join('\n');
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
}

try {
  main();
} catch {
  // A broken check must never break the session.
}
