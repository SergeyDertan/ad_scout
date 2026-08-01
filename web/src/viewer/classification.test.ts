import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, classifyNiche, setClassification, tierFor } from './classification';
import { tierOf } from '../types';

test('a niche nobody has ruled on reads as unknown, never as regular', () => {
  setClassification({});
  assert.equal(tierFor('crypto'), 'unknown');

  // The published data carries sensitive:false on everything (the publisher
  // strips our calls), so "unknown" has to come from the ABSENCE of an answer —
  // not from the flag, which looks identical to a deliberate "regular".
  const offer = classify({ category: 'crypto', sensitive: false });
  assert.equal(offer.tier, 'unknown');
  assert.equal(tierOf(offer), 'unknown');
  assert.equal(offer.sensitive, false);
});

test('his answers drive sensitivity, ours are ignored', () => {
  setClassification({ casino: true, regular: false });

  const casino = classify({ category: 'casino', sensitive: false });
  assert.equal(casino.tier, 'sens');
  assert.equal(casino.sensitive, true, 'existing filters/exports read the boolean');

  // Even if a stale flag ever survived into the snapshot, his "regular" wins.
  const regular = classify({ category: 'regular', sensitive: true });
  assert.equal(regular.tier, 'reg');
  assert.equal(regular.sensitive, false);

  const niche = classifyNiche({ key: 'casino', sensitive: false });
  assert.equal(niche.tier, 'sens');
  assert.equal(niche.sensitive, true);
});

test('unclassifying a niche returns it to unknown', () => {
  setClassification({ vpn: true });
  assert.equal(tierFor('vpn'), 'sens');

  // The panel deletes the key rather than writing false — the two mean
  // different things and must stay distinguishable.
  setClassification({});
  assert.equal(tierFor('vpn'), 'unknown');
});
