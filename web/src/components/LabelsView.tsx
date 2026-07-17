import { Box, Stack, Table, Text } from '@chakra-ui/react';
import { Panel } from './Panel';

// Reference legend for the Gmail labels the pipeline applies to inbound mail.
// Kept in sync by hand with src/domain/labels.ts (the backend source of truth) —
// the web module doesn't import backend code, so the names and the Gmail palette
// colors (bg/fg) are mirrored here to render each badge exactly as Gmail shows it.
type Row = { name: string; bg: string; fg: string; when: string; meaning: string };

// A matched reply, once extraction classifies it (opt-out wins over intent).
const OUTCOME_ROWS: Row[] = [
  {
    name: 'AS/Answered',
    bg: '#16a765',
    fg: '#ffffff',
    when: 'Substantive reply',
    meaning: 'They gave prices or willingness — the answer we were chasing.',
  },
  {
    name: 'AS/Question',
    bg: '#4a86e8',
    fg: '#ffffff',
    when: 'They asked us something',
    meaning: 'A question back to us instead of an answer — usually needs a human.',
  },
  {
    name: 'AS/Holding',
    bg: '#ffad46',
    fg: '#ffffff',
    when: '“We’ll get back to you”',
    meaning: 'Acknowledged but no answer yet; follow-ups keep chasing the real reply.',
  },
  {
    name: 'AS/AutoReply',
    bg: '#999999',
    fg: '#ffffff',
    when: 'Out-of-office',
    meaning: 'Autoresponder / vacation notice — no human read it.',
  },
  {
    name: 'AS/Declined',
    bg: '#fb4c2f',
    fg: '#ffffff',
    when: 'Not interested',
    meaning: 'A clear “no”. The target is closed.',
  },
  {
    name: 'AS/Unsubscribe',
    bg: '#a479e2',
    fg: '#ffffff',
    when: 'Asked to stop',
    meaning: 'Opt-out request — the address is also added to the suppression list.',
  },
];

// Routing labels — applied before (or instead of) an extraction outcome.
const ROUTING_ROWS: Row[] = [
  {
    name: 'AS/Replied',
    bg: '#cccccc',
    fg: '#000000',
    when: 'Matched, not yet classified',
    meaning: 'Tied to a target but extraction hasn’t run yet; becomes one of the outcomes above.',
  },
  {
    name: 'AS/Bounced',
    bg: '#cc3a21',
    fg: '#ffffff',
    when: 'Delivery failure',
    meaning: 'Bounce / NDR. The address is suppressed and the target marked bounced.',
  },
  {
    name: 'AS/Unmatched',
    bg: '#fad165',
    fg: '#000000',
    when: 'No target found',
    meaning: 'Inbound we couldn’t tie to any target — treat this as the manual review queue.',
  },
];

// Rendered exactly as Gmail draws a label chip: solid palette background + text.
function LabelBadge({ name, bg, fg }: { name: string; bg: string; fg: string }) {
  return (
    <Box
      as="span"
      display="inline-block"
      px={2}
      py={0.5}
      rounded="md"
      fontSize="xs"
      fontWeight="medium"
      whiteSpace="nowrap"
      style={{ backgroundColor: bg, color: fg }}
    >
      {name}
    </Box>
  );
}

function LabelTable({ rows }: { rows: Row[] }) {
  return (
    <Table.Root size="md" variant="line">
      <Table.Header>
        <Table.Row bg="bg.subtle">
          <Table.ColumnHeader>Label</Table.ColumnHeader>
          <Table.ColumnHeader>Applied when</Table.ColumnHeader>
          <Table.ColumnHeader>What it means</Table.ColumnHeader>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {rows.map((r) => (
          <Table.Row key={r.name}>
            <Table.Cell>
              <LabelBadge name={r.name} bg={r.bg} fg={r.fg} />
            </Table.Cell>
            <Table.Cell fontWeight="medium" whiteSpace="nowrap">
              {r.when}
            </Table.Cell>
            <Table.Cell color="fg.muted">{r.meaning}</Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table.Root>
  );
}

export function LabelsView() {
  return (
    <Box pt={4}>
      <Text color="fg.muted" fontSize="sm" mb={4}>
        Every inbound message the system fetches is marked <b>read</b> — read simply means “we saw
        it”. The label below records the <b>decision</b> we reached, so you can tell at a glance what
        happened to each message in Gmail. A message carries exactly one <code>AS/</code> label at a
        time; it’s swapped as the decision is refined.
      </Text>

      <Stack gap={6}>
        <Box>
          <Text fontWeight="semibold" fontSize="sm" mb={2}>
            Reply outcomes
          </Text>
          <Panel>
            <LabelTable rows={OUTCOME_ROWS} />
          </Panel>
        </Box>

        <Box>
          <Text fontWeight="semibold" fontSize="sm" mb={2}>
            Routing
          </Text>
          <Panel>
            <LabelTable rows={ROUTING_ROWS} />
          </Panel>
        </Box>
      </Stack>

      <Text color="fg.muted" fontSize="xs" mt={4}>
        Colors match what Gmail shows — each label is created with these exact colors from Gmail’s
        fixed palette. Labels nest under the collapsible <code>AS/</code> group in Gmail’s sidebar;
        the group row itself has no color, only the individual labels do.
      </Text>
    </Box>
  );
}
