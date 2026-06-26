import {
  Box,
  Button,
  Field,
  Heading,
  HStack,
  NativeSelect,
  Text,
  Textarea,
  VStack,
} from '@chakra-ui/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { Campaign } from '../types';
import { Panel } from './Panel';
import { toaster, toastError } from './Toaster';

interface ParsedRow {
  websiteUrl: string;
  contactEmail: string;
  contactName?: string;
}

/** Accept comma, tab, or 2+-space as delimiter. Skip blank lines. */
function parseLines(raw: string): ParsedRow[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const cols = line.includes('\t')
        ? line.split('\t')
        : line.includes(',')
          ? line.split(',')
          : line.split(/\s{2,}/);
      const [website = '', email = '', name = ''] = cols.map((c) => c.trim());
      return { websiteUrl: website, contactEmail: email, contactName: name || undefined };
    })
    .filter((r) => r.websiteUrl && r.contactEmail.includes('@'));
}

/**
 * Parse an Excel/CSV file using SheetJS. Looks for columns named (case-insensitive):
 * website/url/domain → websiteUrl
 * email/contact email/e-mail → contactEmail
 * name/contact name/contact → contactName
 * Falls back to positional (col 0 = website, col 1 = email, col 2 = name) if no header matches.
 */
function parseWorkbook(file: File): Promise<ParsedRow[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const XLSX = await import('xlsx');
        const data = e.target?.result;
        const wb = XLSX.read(data, { type: 'array' });
        const sheet = wb.Sheets[wb.SheetNames[0]!];
        if (!sheet) return resolve([]);

        const raw: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
        if (raw.length === 0) return resolve([]);

        // Detect header row
        const header = (raw[0] as string[]).map((h) => String(h).toLowerCase().trim());
        const websiteIdx = header.findIndex((h) => /website|url|domain|site/.test(h));
        const emailIdx = header.findIndex((h) => /e.?mail/.test(h));
        const nameIdx = header.findIndex((h) => /contact.?name|name|contact/.test(h));

        const hasHeader = websiteIdx !== -1 || emailIdx !== -1;
        const dataRows = hasHeader ? raw.slice(1) : raw;
        const wi = hasHeader ? (websiteIdx === -1 ? 0 : websiteIdx) : 0;
        const ei = hasHeader ? (emailIdx === -1 ? 1 : emailIdx) : 1;
        const ni = hasHeader ? nameIdx : 2;

        const rows: ParsedRow[] = dataRows
          .map((row) => {
            const r = row as string[];
            const website = String(r[wi] ?? '').trim();
            const email = String(r[ei] ?? '').trim();
            const name = ni >= 0 ? String(r[ni] ?? '').trim() : '';
            return { websiteUrl: website, contactEmail: email, contactName: name || undefined };
          })
          .filter((r) => r.websiteUrl && r.contactEmail.includes('@'));

        resolve(rows);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

export function BulkImportForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [text, setText] = useState('');
  const [fileRows, setFileRows] = useState<ParsedRow[] | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campaignId, setCampaignId] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .listCampaigns()
      .then((cs) => {
        setCampaigns(cs);
        setCampaignId(cs[0]?.id ?? '');
      })
      .catch((e) => toastError('Could not load campaigns', e));
  }, []);

  const textRows = useMemo(() => parseLines(text), [text]);
  const rows = fileRows ?? textRows;

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const parsed = await parseWorkbook(file);
      setFileRows(parsed);
      setFileName(file.name);
      setText('');
    } catch (err) {
      toastError('Could not read file', err);
    }
    // reset so re-selecting the same file fires onChange again
    if (fileRef.current) fileRef.current.value = '';
  };

  const clearFile = () => {
    setFileRows(null);
    setFileName(null);
  };

  const submit = async () => {
    if (rows.length === 0 || !campaignId) return;
    setBusy(true);
    setProgress({ done: 0, total: rows.length });
    let ok = 0;
    let fail = 0;
    for (const row of rows) {
      try {
        await api.createTarget({ ...row, campaignId });
        ok++;
      } catch {
        fail++;
      }
      setProgress({ done: ok + fail, total: rows.length });
    }
    setBusy(false);
    setProgress(null);
    if (fail === 0) {
      toaster.create({ type: 'success', title: `${ok} target${ok !== 1 ? 's' : ''} queued` });
    } else {
      toaster.create({
        type: 'warning',
        title: `${ok} queued, ${fail} failed`,
        description: 'Check for duplicate emails or missing campaigns.',
      });
    }
    onCreated();
    onClose();
  };

  return (
    <Panel p={5} mb={4}>
      <Heading size="sm" mb={1}>
        Bulk import targets
      </Heading>
      <Text color="fg.muted" fontSize="sm" mb={4}>
        Upload an Excel or CSV file, or paste rows directly.
      </Text>

      <Field.Root mb={4}>
        <Field.Label>Campaign</Field.Label>
        <NativeSelect.Root maxW="xs">
          <NativeSelect.Field value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </NativeSelect.Field>
          <NativeSelect.Indicator />
        </NativeSelect.Root>
      </Field.Root>

      {/* File upload zone */}
      <Box
        mb={4}
        borderWidth="2px"
        borderStyle="dashed"
        borderColor={fileName ? 'green.emphasized' : 'border'}
        bg={fileName ? 'green.subtle' : 'bg.subtle'}
        rounded="lg"
        px={5}
        py={4}
        cursor="pointer"
        onClick={() => !fileName && fileRef.current?.click()}
        _hover={!fileName ? { borderColor: 'brand.emphasized', bg: 'brand.subtle' } : {}}
        transition="all 0.15s"
      >
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.xls,.csv,.ods"
          style={{ display: 'none' }}
          onChange={handleFile}
        />
        {fileName ? (
          <HStack justify="space-between">
            <VStack align="flex-start" gap={0}>
              <Text fontWeight="semibold" fontSize="sm" color="green.fg">
                {fileName}
              </Text>
              <Text fontSize="xs" color="fg.muted">
                {rows.length} valid row{rows.length !== 1 ? 's' : ''} found
              </Text>
            </VStack>
            <Button size="xs" variant="ghost" colorPalette="red" onClick={clearFile}>
              Remove
            </Button>
          </HStack>
        ) : (
          <VStack gap={1}>
            <Text fontSize="sm" color="fg.muted" textAlign="center">
              Click to upload <Box as="span" fontWeight="semibold">.xlsx</Box>,{' '}
              <Box as="span" fontWeight="semibold">.xls</Box>, or{' '}
              <Box as="span" fontWeight="semibold">.csv</Box>
            </Text>
            <Text fontSize="xs" color="fg.subtle">
              Columns: <Box as="code">website</Box> · <Box as="code">email</Box> ·{' '}
              <Box as="code">name</Box> (optional). Positional if no header.
            </Text>
          </VStack>
        )}
      </Box>

      {/* Paste fallback — hidden when a file is loaded */}
      {!fileName && (
        <Field.Root>
          <Field.Label>Or paste rows</Field.Label>
          <Textarea
            rows={8}
            fontFamily="mono"
            fontSize="sm"
            placeholder={
              'egamersworld.com, info@egamersworld.com\ncasino.org, editor@casino.org, John\nbetting-tips.net, contact@betting-tips.net'
            }
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          {textRows.length > 0 && (
            <Field.HelperText color="green.fg">
              {textRows.length} valid row{textRows.length !== 1 ? 's' : ''} parsed
            </Field.HelperText>
          )}
        </Field.Root>
      )}

      <HStack mt={5} justify="flex-end">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          colorPalette="brand"
          onClick={submit}
          loading={busy}
          disabled={rows.length === 0 || !campaignId}
          loadingText={progress ? `${progress.done} / ${progress.total}` : undefined}
        >
          Queue {rows.length > 0 ? rows.length : ''} target{rows.length !== 1 ? 's' : ''}
        </Button>
      </HStack>
    </Panel>
  );
}
