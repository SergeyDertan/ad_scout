import test from 'node:test';
import assert from 'node:assert/strict';

import { ALL_LABELS, LABEL_COLORS, LABELS, labelForResult } from './labels';
import type { OutreachResult } from './types';

function result(over: Partial<OutreachResult>): OutreachResult {
  return { canPost: 'maybe', optOut: false, offers: [], ...over };
}

test('opt-out overrides intent', () => {
  assert.equal(labelForResult(result({ optOut: true, intent: 'answer' })), LABELS.unsubscribe);
});

test('maps each intent to its label', () => {
  assert.equal(labelForResult(result({ intent: 'answer' })), LABELS.answered);
  assert.equal(labelForResult(result({ intent: 'decline' })), LABELS.declined);
  assert.equal(labelForResult(result({ intent: 'question' })), LABELS.question);
  assert.equal(labelForResult(result({ intent: 'auto_reply' })), LABELS.autoReply);
  assert.equal(labelForResult(result({ intent: 'holding' })), LABELS.holding);
  assert.equal(labelForResult(result({ intent: 'other' })), LABELS.matched);
});

test('defaults a missing intent to answered', () => {
  assert.equal(labelForResult(result({})), LABELS.answered);
});

test('every managed label has a Gmail palette color', () => {
  for (const label of ALL_LABELS) {
    const color = LABEL_COLORS[label];
    assert.ok(color, `missing color for ${label}`);
    assert.match(color.backgroundColor, /^#[0-9a-f]{6}$/);
    assert.match(color.textColor, /^#[0-9a-f]{6}$/);
  }
});
