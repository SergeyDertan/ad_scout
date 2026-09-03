// Pin the process timezone, and prove it actually took effect.
//
// WHY THIS EXISTS: the send window (scheduler/window.ts) and the daily quota
// reset (domain/limits.ts, domain/account-state.ts) are computed with
// getHours() / setHours() — local clock, no timezone argument anywhere. The host
// OS therefore decides when this app sends mail. A VPS whose clock zone is not
// the one you reason about does not fail; it silently sends at the wrong hours
// and rolls the daily quota at the wrong moment, and the first sign is weeks of
// outreach landing at 3am in the target's morning.
//
// So the app pins it rather than inheriting it. `TZ` in .env is authoritative,
// whatever the box is set to.
//
// ORDERING: Node reads TZ at startup, but also honours a change to
// process.env.TZ afterwards. `import 'dotenv/config'` is the first import in
// every entry point, so TZ is in the environment before any of our modules
// evaluate — and nothing in src/ caches a Date or an Intl formatter at module
// scope, so there is nothing already frozen to a stale zone.

/**
 * Do the ambient timezone and `want` describe the same clock?
 *
 * Compared by OFFSET, not by name: Node's ICU resolves several zone names to
 * their older aliases — ask for "Europe/Kyiv" and resolvedOptions() reports
 * "Europe/Kiev". A string comparison would reject a perfectly correct setting.
 *
 * Two instants, one per side of the year, so a zone that merely shares an offset
 * in winter but differs in its DST rules is still caught.
 */
function zonesAgree(want: string): boolean {
  const probes = [new Date('2026-01-15T12:00:00Z'), new Date('2026-07-15T12:00:00Z')];
  const format = (at: Date, timeZone?: string): string =>
    new Intl.DateTimeFormat('en-GB', {
      ...(timeZone ? { timeZone } : {}),
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    }).format(at);
  return probes.every((at) => format(at) === format(at, want));
}

export interface TimezoneReport {
  /** What the runtime resolved to — may be an alias of what you asked for. */
  resolved: string;
  /** What TZ requested, when it was set. */
  requested?: string;
}

/**
 * Apply `TZ` to this process and verify it. Throws on a name the runtime does
 * not know, or on a value that did not take effect — both are configuration
 * mistakes that are far cheaper to hit at boot than to discover in a month of
 * mistimed sends.
 */
export function applyTimezone(env: NodeJS.ProcessEnv = process.env): TimezoneReport {
  const want = env.TZ?.trim();
  if (!want) {
    // A PRESENT-BUT-BLANK TZ is not the same as an absent one: Node takes the
    // empty string literally and resolves to "Etc/Unknown", which is UTC wearing
    // a disguise — so `TZ=` left empty in .env would silently shift the whole
    // send window. Remove it so the host's real zone is used instead.
    if (env.TZ !== undefined && env === process.env) delete process.env.TZ;
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (resolved === 'Etc/Unknown') {
      throw new Error(
        'The process timezone resolved to "Etc/Unknown" — TZ is set to an empty or ' +
          'unusable value. Set TZ to an IANA name (e.g. Europe/Kyiv) or remove it entirely.',
      );
    }
    // Inheriting the host's zone. Legitimate on a laptop; on a server it is the
    // thing this module exists to warn about, so the caller logs it loudly.
    return { resolved };
  }

  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: want });
  } catch {
    throw new Error(
      `TZ="${want}" is not a timezone this runtime knows. Use an IANA name, e.g. Europe/Kyiv.`,
    );
  }

  process.env.TZ = want;

  if (!zonesAgree(want)) {
    throw new Error(
      `TZ="${want}" did not take effect — the process is still on ` +
        `${Intl.DateTimeFormat().resolvedOptions().timeZone}. Set TZ in the environment ` +
        'before starting Node (the systemd unit does this).',
    );
  }

  return { resolved: Intl.DateTimeFormat().resolvedOptions().timeZone, requested: want };
}

/** "14:32 Europe/Kiev (requested Europe/Kyiv)" — for the boot log. */
export function describeTimezone(report: TimezoneReport, now: Date): string {
  const time = new Intl.DateTimeFormat('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit' }).format(now);
  const alias =
    report.requested && report.requested !== report.resolved ? ` (requested ${report.requested})` : '';
  return `${time} ${report.resolved}${alias}`;
}
