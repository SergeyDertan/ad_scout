// Snapshot object names. Mirrors src/services/snapshot.ts (snapshotSlug /
// replyPath / domainPath) — the two MUST agree exactly, or the viewer asks for
// files the publisher never wrote. Change both together.
//
// Why not percent-encoding: a few keys are messy (one botched extraction left a
// "domain" reading `foo.com and bar.com`), and an object name containing '%' is
// re-encoded by the Storage SDK on the way back out, so the file becomes
// unreachable. Restricting the charset avoids that entirely; a rewritten key
// carries a hash of the original so two keys can never share a file.

function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function snapshotSlug(key: string): string {
  const safe = key
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return safe === key ? key : `${safe || 'x'}-${fnv1a(key)}`;
}

export function replyFile(id: string): string {
  return `reply/${snapshotSlug(id)}.json`;
}

export function domainFile(domain: string): string {
  return `domain/${snapshotSlug(domain)}.json`;
}
