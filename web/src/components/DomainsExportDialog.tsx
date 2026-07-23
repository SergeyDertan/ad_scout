import {
  Badge,
  Box,
  Button,
  CloseButton,
  Dialog,
  Field,
  HStack,
  Input,
  Portal,
  Table,
  Text,
  VStack,
} from '@chakra-ui/react';
import { useMemo, useState } from 'react';
import type { DomainSummary } from '../types';
import {
  DOMAIN_EXPORT_SCOPES,
  buildDomainsExport,
  defaultDomainsHeader,
  exportDomainsXlsx,
  type DomainExportScope,
} from '../export/domains';
import { toaster, toastError } from './Toaster';
import { DownloadIcon } from './icons';

const PREVIEW_ROWS = 8;

/**
 * Export the currently-filtered domains to XLSX. The scope picker chooses the
 * sheet's shape and the table below previews the exact columns/rows that will be
 * written (first {@link PREVIEW_ROWS} rows), so the user sees the result before
 * downloading.
 */
export function DomainsExportDialog({
  domains,
  onClose,
}: {
  domains: DomainSummary[];
  onClose: () => void;
}) {
  const [scope, setScope] = useState<DomainExportScope>('both');
  const [header, setHeader] = useState(() => defaultDomainsHeader());
  const [busy, setBusy] = useState(false);

  const table = useMemo(() => buildDomainsExport(domains, scope), [domains, scope]);
  const previewRows = table.body.slice(0, PREVIEW_ROWS);
  const overflow = table.body.length - previewRows.length;

  const doExport = async () => {
    setBusy(true);
    try {
      await exportDomainsXlsx(domains, scope, header);
      toaster.create({ type: 'success', title: 'Spreadsheet downloaded' });
      onClose();
    } catch (e) {
      toastError('Could not build the spreadsheet', e);
    } finally {
      setBusy(false);
    }
  };

  const fmt = (v: string | number) => (v === '' || v == null ? '—' : String(v));

  return (
    <Dialog.Root open onOpenChange={(e) => { if (!e.open) onClose(); }} size="xl" placement="center" scrollBehavior="inside">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content rounded="xl" maxW="820px">
            <Dialog.Header>
              <Dialog.Title>Export domains</Dialog.Title>
            </Dialog.Header>

            <Dialog.Body>
              <VStack align="stretch" gap={4}>
                <Text fontSize="sm" color="fg.muted">
                  Exports the <b>{domains.length}</b> domain{domains.length === 1 ? '' : 's'} matching your
                  current filters. A price shows only when the publisher will post it.
                </Text>

                <Field.Root>
                  <Field.Label>Columns</Field.Label>
                  <HStack gap={2} flexWrap="wrap">
                    {DOMAIN_EXPORT_SCOPES.map((s) => (
                      <Button
                        key={s.value}
                        size="sm"
                        variant={scope === s.value ? 'solid' : 'outline'}
                        colorPalette={scope === s.value ? 'brand' : 'gray'}
                        onClick={() => setScope(s.value)}
                      >
                        {s.label}
                      </Button>
                    ))}
                  </HStack>
                  <Field.HelperText>
                    {DOMAIN_EXPORT_SCOPES.find((s) => s.value === scope)?.hint}
                  </Field.HelperText>
                </Field.Root>

                <Field.Root>
                  <Field.Label>Title</Field.Label>
                  <Input value={header} onChange={(e) => setHeader(e.target.value)} />
                  <Field.HelperText>Written into the first row of the sheet.</Field.HelperText>
                </Field.Root>

                <Box>
                  <HStack justify="space-between" mb={2}>
                    <Text fontSize="sm" fontWeight="semibold" color="fg.muted">Preview</Text>
                    <Badge variant="surface" size="sm">
                      {table.columns.length} column{table.columns.length === 1 ? '' : 's'}
                    </Badge>
                  </HStack>
                  <Box borderWidth="1px" borderColor="border" rounded="md" overflow="auto" maxH="360px">
                    <Table.Root size="sm" variant="line" stickyHeader>
                      <Table.Header>
                        <Table.Row bg="bg.subtle">
                          {table.columns.map((c, i) => (
                            <Table.ColumnHeader key={i} whiteSpace="nowrap">{c}</Table.ColumnHeader>
                          ))}
                        </Table.Row>
                      </Table.Header>
                      <Table.Body>
                        {previewRows.length === 0 ? (
                          <Table.Row>
                            <Table.Cell colSpan={table.columns.length}>
                              <Text fontSize="sm" color="fg.muted" py={2}>No domains to export.</Text>
                            </Table.Cell>
                          </Table.Row>
                        ) : (
                          previewRows.map((row, ri) => (
                            <Table.Row key={ri}>
                              {table.columns.map((_, ci) => (
                                <Table.Cell
                                  key={ci}
                                  whiteSpace="nowrap"
                                  fontWeight={ci === 0 ? 'medium' : undefined}
                                  color={row[ci] === '' || row[ci] == null ? 'fg.subtle' : undefined}
                                >
                                  {fmt(row[ci])}
                                </Table.Cell>
                              ))}
                            </Table.Row>
                          ))
                        )}
                      </Table.Body>
                    </Table.Root>
                  </Box>
                  {overflow > 0 && (
                    <Text fontSize="xs" color="fg.subtle" mt={2}>
                      Showing first {previewRows.length} — {overflow} more row{overflow === 1 ? '' : 's'} in the file.
                    </Text>
                  )}
                </Box>
              </VStack>
            </Dialog.Body>

            <Dialog.Footer>
              <Button variant="ghost" onClick={onClose} disabled={busy}>Close</Button>
              <Button colorPalette="brand" onClick={doExport} loading={busy} disabled={domains.length === 0}>
                <DownloadIcon /> Download XLSX
              </Button>
            </Dialog.Footer>

            <Dialog.CloseTrigger asChild>
              <CloseButton size="sm" disabled={busy} />
            </Dialog.CloseTrigger>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
