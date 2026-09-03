import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTimezone, describeTimezone } from './timezone';

// applyTimezone mutates process.env.TZ, which is process-global. node --test
// runs each file in its own process, but restore anyway so ordering inside this
// file cannot leak into the next test.
const ORIGINAL = process.env.TZ;
function restore(): void {
  if (ORIGINAL === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL;
}

/** Wall-clock hour for a fixed instant, in whatever zone the process is on. */
function ambientHour(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { hour12: false, hour: '2-digit' }).format(new Date(iso));
}

test('TZ actually moves the process clock, not just the reported name', () => {
  try {
    applyTimezone({ TZ: 'UTC' } as NodeJS.ProcessEnv);
    const utc = ambientHour('2026-07-15T12:00:00Z');
    applyTimezone({ TZ: 'Asia/Tokyo' } as NodeJS.ProcessEnv);
    const tokyo = ambientHour('2026-07-15T12:00:00Z');
    assert.equal(utc, '12');
    assert.equal(tokyo, '21'); // UTC+9
  } finally {
    restore();
  }
});

test('a zone whose canonical name differs is accepted, not rejected', () => {
  // Node's ICU reports "Europe/Kyiv" as "Europe/Kiev". Comparing names would
  // reject a perfectly correct setting, so the check compares offsets.
  try {
    const report = applyTimezone({ TZ: 'Europe/Kyiv' } as NodeJS.ProcessEnv);
    assert.ok(report.resolved.startsWith('Europe/'), `unexpected zone ${report.resolved}`);
    assert.equal(report.requested, 'Europe/Kyiv');
    // Kyiv is UTC+3 in July.
    assert.equal(ambientHour('2026-07-15T12:00:00Z'), '15');
  } finally {
    restore();
  }
});

test('an unknown zone name fails at boot with a usable message', () => {
  try {
    assert.throws(
      () => applyTimezone({ TZ: 'Mars/Olympus' } as NodeJS.ProcessEnv),
      /not a timezone this runtime knows/,
    );
  } finally {
    restore();
  }
});

test('a blank TZ falls back to the host zone instead of Etc/Unknown', () => {
  // `TZ=` left empty in .env is the realistic mistake. Node takes the empty
  // string literally and resolves to Etc/Unknown — UTC in disguise — which would
  // silently shift the entire send window.
  try {
    process.env.TZ = '';
    const report = applyTimezone();
    assert.notEqual(report.resolved, 'Etc/Unknown');
    assert.equal(report.requested, undefined);
  } finally {
    restore();
  }
});

test('describeTimezone names the alias so a correct setting does not look wrong', () => {
  const at = new Date('2026-07-15T12:00:00Z');
  assert.match(
    describeTimezone({ resolved: 'Europe/Kiev', requested: 'Europe/Kyiv' }, at),
    /Europe\/Kiev \(requested Europe\/Kyiv\)/,
  );
  // No parenthetical when the runtime agreed with what was asked for.
  assert.doesNotMatch(describeTimezone({ resolved: 'UTC', requested: 'UTC' }, at), /requested/);
});
