import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Mutex } from './mutex';

const tick = () => new Promise((r) => setImmediate(r));

test('Mutex serializes overlapping tasks — no interleaving', async () => {
  const m = new Mutex();
  const events: string[] = [];
  const task = (name: string) => async () => {
    events.push(`${name}:start`);
    await tick();
    await tick();
    events.push(`${name}:end`);
  };
  // Kick off three without awaiting between them — they all contend at once.
  const all = Promise.all([m.run(task('a')), m.run(task('b')), m.run(task('c'))]);
  await all;
  // Each task's start/end are adjacent (it ran to completion before the next began).
  assert.deepEqual(events, [
    'a:start', 'a:end',
    'b:start', 'b:end',
    'c:start', 'c:end',
  ]);
});

test('Mutex resolves with the task result', async () => {
  const m = new Mutex();
  const v = await m.run(async () => 42);
  assert.equal(v, 42);
});

test('Mutex: a rejecting task rejects its own caller but does not break the queue', async () => {
  const m = new Mutex();
  const ran: string[] = [];
  const bad = m.run(async () => {
    ran.push('bad');
    throw new Error('boom');
  });
  const good = m.run(async () => {
    ran.push('good');
    return 'ok';
  });
  await assert.rejects(bad, /boom/);
  assert.equal(await good, 'ok');
  assert.deepEqual(ran, ['bad', 'good']);
});
