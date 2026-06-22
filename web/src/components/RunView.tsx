import { Box, Button, Code, HStack, Text, VStack } from '@chakra-ui/react';
import { useState } from 'react';
import { api } from '../api';

export function RunView() {
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState<'send' | 'poll' | null>(null);

  const append = (line: string) => setLog((l) => [...l, line]);

  const run = async (kind: 'send' | 'poll') => {
    setBusy(kind);
    append(`▶ ${kind}…`);
    try {
      const report = await (kind === 'send' ? api.runSend() : api.runPoll());
      append('  ' + JSON.stringify(report));
    } catch (e) {
      append('  error: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Box pt={4}>
      <VStack align="stretch" gap={3}>
        <HStack>
          <Button colorPalette="blue" onClick={() => run('send')} loading={busy === 'send'}>
            Run send pass
          </Button>
          <Button variant="outline" onClick={() => run('poll')} loading={busy === 'poll'}>
            Run poll pass
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setLog([])} disabled={log.length === 0}>
            Clear
          </Button>
        </HStack>
        <Text color="fg.muted" fontSize="sm">
          Manual passes respect the daily cap; the scheduler drips automatically within the send
          window.
        </Text>
        <Box
          as="pre"
          bg="bg.subtle"
          borderWidth="1px"
          borderColor="border"
          rounded="md"
          p={3}
          minH="280px"
          maxH="420px"
          overflow="auto"
          fontSize="xs"
        >
          {log.length === 0 ? (
            <Code color="fg.subtle" bg="transparent">
              (no output yet)
            </Code>
          ) : (
            log.join('\n')
          )}
        </Box>
      </VStack>
    </Box>
  );
}
