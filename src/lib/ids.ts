import { randomUUID } from 'node:crypto';

/** `<prefix>_<uuid>` id. Not pure (random) — lives outside the domain core. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

/** A self-set RFC Message-Id for exact self-lookup (overview.md §4). */
export function newMessageId(domain = 'adscout.local'): string {
  return `<${randomUUID()}@${domain}>`;
}
