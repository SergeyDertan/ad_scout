// Separating what a publisher actually WROTE from the thread they quoted back.
//
// Email replies carry their own history: our pitch, quoted; their previous
// message, quoted; sometimes four rounds of it. Rendered verbatim in a chat
// view that is mostly noise — you scroll past your own words to find the one
// line that says "150 EUR". Every real mail client collapses this, and so do we.
//
// The rule is deliberately conservative: find the FIRST marker that begins a
// quoted region, and if anything at all is left before it, that prefix is the
// message. When a marker leaves nothing before it (a reply that is only a
// forward, say) nothing is stripped — an empty bubble is worse than a noisy one.

/** Attribution lines end with a "wrote:" verb. The locales publishers actually
 *  answer in; anything unmatched simply stays visible, which is the safe way to
 *  be wrong. */
const WROTE_VERBS = /(wrote|writes|schrieb|escribió|ha scritto|napisał|пишет|написав|написал)\s*:\s*$/i;

/** A single-line attribution: "On Tue, 12 Mar 2026 at 10:02, admin@site.com wrote:" */
function isAttribution(line: string): boolean {
  const t = line.trim();
  return t.length > 0 && t.length <= 200 && WROTE_VERBS.test(t);
}

/** Outlook's and Gmail's block separators. */
function isSeparator(line: string): boolean {
  const t = line.trim();
  return (
    /^-{2,}\s*(original message|forwarded message)\s*-{2,}$/i.test(t) ||
    /^_{8,}$/.test(t) ||
    /^-{5,}$/.test(t)
  );
}

function isQuoted(line: string): boolean {
  return /^\s*>/.test(line);
}

/**
 * Where the quoted region starts, or -1.
 *
 * Each marker is checked at every line and the earliest wins, because clients
 * disagree about which one they emit — Gmail an attribution, Outlook a "From:"
 * header block, older clients a rule of underscores.
 */
function quoteStart(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (isSeparator(line)) return i;

    // "On <date>, <someone> wrote:" — often wrapped across two or three lines,
    // so join forward until the verb appears or the window runs out.
    if (/^\s*(on|am|el|le|il)\b/i.test(line) || isAttribution(line)) {
      let joined = line.trim();
      for (let j = i; j < Math.min(i + 3, lines.length); j++) {
        if (j > i) joined += ` ${lines[j]!.trim()}`;
        if (isAttribution(joined)) return i;
      }
    }

    // Outlook's quoted header block: "From:" immediately followed by the rest
    // of the envelope. "From:" alone is a line a person can plausibly type.
    if (/^\s*from:\s*\S/i.test(line)) {
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        if (/^\s*(sent|date|to|cc|subject):/i.test(lines[j]!)) return i;
      }
    }

    // A run of ">" lines. Two in a row, so a single line that merely opens with
    // a chevron ("> 150 is fine") is not mistaken for a quote.
    if (isQuoted(line) && i + 1 < lines.length && isQuoted(lines[i + 1]!)) return i;
  }
  return -1;
}

export interface SplitMessage {
  /** What they wrote this time. Never empty unless the message itself is. */
  body: string;
  /** The thread quoted underneath, when there was one. */
  quoted?: string;
}

/** Split a received (or sent) email body into the new text and the quoted tail. */
export function splitQuoted(text: string): SplitMessage {
  const lines = text.split('\n');
  const start = quoteStart(lines);
  if (start <= 0) return { body: text.trim() };

  const body = lines.slice(0, start).join('\n').trim();
  // Nothing but a quote: show it whole rather than an empty bubble.
  if (!body) return { body: text.trim() };

  const quoted = lines.slice(start).join('\n').trim();
  return quoted ? { body, quoted } : { body };
}
