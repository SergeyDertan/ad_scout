import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  pastedName,
  rejectReason,
} from './attachments';
import type { EmailAttachment } from './types';

function staged(...sizes: number[]): EmailAttachment[] {
  return sizes.map((size, i) => ({
    filename: `f${i}.png`,
    mimeType: 'image/png',
    size,
    contentBase64: '',
  }));
}

test('an ordinary screenshot is simply accepted', () => {
  assert.equal(rejectReason([], { name: 'shot.png', size: 480 * 1024 }), undefined);
});

test('the reason names the file and the limit, because "too big" is not actionable', () => {
  const reason = rejectReason([], { name: 'recording.mov', size: MAX_ATTACHMENT_BYTES + 1 })!;
  assert.match(reason, /recording\.mov/);
  assert.match(reason, /5\.0 MB/);
});

// The per-file cap and the per-message total are different limits: four files
// that each pass can still be more than one email can carry.
test('a file that fits on its own can still bust the message total', () => {
  const file = { name: 'shot.png', size: 2 * 1024 * 1024 };
  assert.equal(rejectReason([], file), undefined);
  const reason = rejectReason(staged(2 * 1024 * 1024), file)!;
  assert.match(reason, /more than one email can carry/);
});

test('an empty file is rejected rather than sent as a zero-byte part', () => {
  assert.match(rejectReason([], { name: 'empty.png', size: 0 })!, /empty/);
});

test('the count cap is stated in files, not bytes', () => {
  const full = staged(...Array(MAX_ATTACHMENTS_PER_MESSAGE).fill(1024));
  assert.match(rejectReason(full, { name: 'one-more.png', size: 10 })!, /at most/i);
});

// Every screenshot pasted from the clipboard arrives as "image.png", so three in
// one message would otherwise be three files with identical names.
test('a pasted screenshot is named by when it was pasted', () => {
  const at = new Date('2026-09-07T14:32:05Z');
  assert.equal(pastedName('image/png', at), 'screenshot-2026-09-07-14-32-05.png');
  assert.equal(pastedName('image/jpeg', at), 'screenshot-2026-09-07-14-32-05.jpeg');
  assert.equal(pastedName('', at), 'screenshot-2026-09-07-14-32-05.png', 'a typeless paste still gets a name');
});
