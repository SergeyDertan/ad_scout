// Mailbox labels (overview.md §8). Every inbound message the system *sees* is
// marked read; the label records the *decision* we reached about it, so a human
// scanning Gmail can tell at a glance what happened to each message. Names are
// nested under the "AS/" group so they collapse into one folder in the sidebar.
//
// A message carries exactly ONE of these at a time: the provider swaps the old
// AS/ label for the new one when a decision is refined (e.g. a matched reply
// starts as AS/Replied and becomes AS/Answered once extraction classifies it).

import type { OutreachResult } from './types';

/** The full set of managed labels, keyed by decision. Values are the Gmail names. */
export const LABELS = {
  /** Matched to a target, no extraction verdict yet (or intent 'other'). */
  matched: 'AS/Replied',
  /** Substantive answer — gave prices/willingness (intent 'answer'). */
  answered: 'AS/Answered',
  /** Explicitly not interested (intent 'decline'). */
  declined: 'AS/Declined',
  /** They asked us something without answering (intent 'question'). */
  question: 'AS/Question',
  /** Out-of-office / autoresponder (intent 'auto_reply'). */
  autoReply: 'AS/AutoReply',
  /** Acknowledged, promised a later reply (intent 'holding'). */
  holding: 'AS/Holding',
  /** Asked to stop being contacted (optOut) — overrides intent. */
  unsubscribe: 'AS/Unsubscribe',
  /** On a thread belonging to an open deal: a human is handling this one, so the
   *  pipeline stored it and did nothing else. Never set by extraction. */
  deal: 'AS/Deal',
  /** Delivery failure / NDR. */
  bounced: 'AS/Bounced',
  /** Inbound we could not tie to any target — a human may want to look. */
  unmatched: 'AS/Unmatched',
  /** Dropped before processing — on the ignore list (spam / automated sender). */
  ignored: 'AS/Ignored',
} as const;

export type OutcomeLabel = (typeof LABELS)[keyof typeof LABELS];

/** Every managed label name — the universe the provider swaps within. */
export const ALL_LABELS: readonly OutcomeLabel[] = Object.values(LABELS);

/** A Gmail label color. Both fields MUST be values from Gmail's fixed palette —
 *  an arbitrary hex makes labels.create/update reject with HTTP 400. */
export interface LabelColor {
  backgroundColor: string;
  textColor: string;
}

/**
 * The color each label is created with, so the mailbox is scannable at a glance
 * and matches the console legend. Every value below is drawn from Gmail's allowed
 * label palette. Grouped by meaning: greens = good, reds = dead, orange/yellow =
 * pending/attention, blue = question, purple = opt-out, grays = neutral.
 */
export const LABEL_COLORS: Record<OutcomeLabel, LabelColor> = {
  [LABELS.answered]: { backgroundColor: '#16a765', textColor: '#ffffff' }, // green
  [LABELS.question]: { backgroundColor: '#4a86e8', textColor: '#ffffff' }, // blue
  [LABELS.holding]: { backgroundColor: '#ffad46', textColor: '#ffffff' }, // orange
  [LABELS.autoReply]: { backgroundColor: '#999999', textColor: '#ffffff' }, // gray
  [LABELS.declined]: { backgroundColor: '#fb4c2f', textColor: '#ffffff' }, // red
  [LABELS.unsubscribe]: { backgroundColor: '#a479e2', textColor: '#ffffff' }, // purple
  [LABELS.deal]: { backgroundColor: '#2da2bb', textColor: '#ffffff' }, // teal (a human has it)
  [LABELS.matched]: { backgroundColor: '#cccccc', textColor: '#000000' }, // light gray (provisional)
  [LABELS.bounced]: { backgroundColor: '#cc3a21', textColor: '#ffffff' }, // dark red
  [LABELS.unmatched]: { backgroundColor: '#fad165', textColor: '#000000' }, // yellow (look at me)
  [LABELS.ignored]: { backgroundColor: '#666666', textColor: '#ffffff' }, // dark gray (dropped)
};

/**
 * The decision label for an extracted reply. Opt-out wins over everything (it is
 * terminal and compliance-relevant); otherwise the label follows `intent`, which
 * defaults to 'answer' when the extractor didn't set it.
 */
export function labelForResult(result: OutreachResult): OutcomeLabel {
  if (result.optOut) return LABELS.unsubscribe;
  switch (result.intent ?? 'answer') {
    case 'answer':
      return LABELS.answered;
    case 'decline':
      return LABELS.declined;
    case 'question':
      return LABELS.question;
    case 'auto_reply':
      return LABELS.autoReply;
    case 'holding':
      return LABELS.holding;
    default: // 'other'
      return LABELS.matched;
  }
}
