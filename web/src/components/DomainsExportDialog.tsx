import {
  Badge,
  Box,
  Button,
  Checkbox,
  CloseButton,
  Dialog,
  Field,
  HStack,
  Input,
  Portal,
  Spinner,
  Table,
  Text,
  VStack,
} from '@chakra-ui/react';
import { useEffect, useMemo, useState } from 'react';
import { api, type DomainExportPreview, type DomainPageQuery } from '../api';
import {
  DOMAIN_EXPORT_SCOPES,
  defaultDomainsHeader,
  type DomainExportScope,
} from '../export/domains';
import { toaster, toastError } from './Toaster';
import { DownloadIcon } from './icons';

const PREVIEW_ROWS = 8;

/**
 * Export every domain matching the current filters to XLSX. The scope picker
 * chooses the sheet's shape and the table below previews the exact columns and
 * first rows the server will write, so the user sees the result before
 * downloading.
 *
 * Both the preview and the file come from `GET /api/domains/export`: the browser
 * never sees the whole result set, and in the 'all' shape the column list
 * depends on every exported row, so a preview built from the page on screen
 * would promise a different sheet from the one that arrives.
 *
 * Excluded domains are dropped by default — an export is an outreach/buying
 * list, and excluded domains are exactly the ones we don't want on it.
 */
export function DomainsExportDialog({
  filters,
  scopeLabel,
  defaultIncludeExcluded = false,
  onClose,
}: {
  /** The list's filters, passed through to the export untouched. */
  filters: DomainPageQuery;
  /** The batch the list is filtered to, if any — titles the sheet and its file. */
  scopeLabel?: string;
  /** Start with excluded domains kept — used when the list is already filtered to them. */
  defaultIncludeExcluded?: boolean;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<DomainExportScope>('both');
  // Only the initial value: a title the user has edited is theirs to keep, and
  // this dialog is closed and rebuilt whenever the filters change anyway.
  const [header, setHeader] = useState(() => defaultDomainsHeader(scopeLabel));
  const [includeExcluded, setIncludeExcluded] = useState(defaultIncludeExcluded);
  const [preview, setPreview] = useState<DomainExportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const query = useMemo(
    () => ({ filters, scope, includeExcluded }),
    [filters, includeExcluded, scope],
  );

  // The shape changes with the scope and with whether excluded rows are in, so
  // the preview is refetched for each. Superseded requests are abandoned.
  useEffect(() => {
    const abort = new AbortController();
    setError(null);
    api.previewDomainsExport(query, PREVIEW_ROWS, abort.signal)
      .then(setPreview)
      .catch((e) => {
        if (abort.signal.aborted) return;
        setPreview(null);
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => abort.abort();
  }, [query]);

  const doExport = async () => {
    setBusy(true);
    try {
      await api.downloadDomainsExport({ ...query, title: header });
      toaster.create({ type: 'success', title: 'Spreadsheet downloaded' });
      onClose();
    } catch (e) {
      toastError('Could not build the spreadsheet', e);
    } finally {
      setBusy(false);
    }
  };

  const columns = preview?.columns ?? [];
  const rows = preview?.body ?? [];
  const total = preview?.total ?? 0;
  const overflow = total - rows.length;
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
                  {error ? (
                    <Text as="span" color="red.fg">{error}</Text>
                  ) : preview ? (
                    <>
                      Exports <b>{total}</b> domain{total === 1 ? '' : 's'} — every one matching your current
                      filters, not just the page on screen. A price shows only when the publisher will post it.
                    </>
                  ) : (
                    'Counting the domains that match…'
                  )}
                </Text>

                <Checkbox.Root
                  checked={includeExcluded}
                  onCheckedChange={(d) => setIncludeExcluded(Boolean(d.checked))}
                  disabled={!preview || (!includeExcluded && preview.excluded === 0)}
                >
                  <Checkbox.HiddenInput />
                  <Checkbox.Control />
                  <Checkbox.Label fontSize="sm">
                    Include excluded domains
                    {preview && !includeExcluded && (
                      <Text as="span" color="fg.subtle" ml={1.5}>
                        ({preview.excluded} excluded, left out)
                      </Text>
                    )}
                  </Checkbox.Label>
                </Checkbox.Root>

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
                  <Field.HelperText>Written into the first row of the sheet, and its filename.</Field.HelperText>
                </Field.Root>

                <Box>
                  <HStack justify="space-between" mb={2}>
                    <Text fontSize="sm" fontWeight="semibold" color="fg.muted">Preview</Text>
                    {preview && (
                      <Badge variant="surface" size="sm">
                        {columns.length} column{columns.length === 1 ? '' : 's'}
                      </Badge>
                    )}
                  </HStack>
                  <Box borderWidth="1px" borderColor="border" rounded="md" overflow="auto" maxH="360px">
                    {!preview ? (
                      <HStack color="fg.muted" fontSize="sm" gap={2} p={4}>
                        <Spinner size="sm" /><Text>Building the preview…</Text>
                      </HStack>
                    ) : (
                      <Table.Root size="sm" variant="line" stickyHeader>
                        <Table.Header>
                          <Table.Row bg="bg.subtle">
                            {columns.map((c, i) => (
                              <Table.ColumnHeader key={i} whiteSpace="nowrap">{c}</Table.ColumnHeader>
                            ))}
                          </Table.Row>
                        </Table.Header>
                        <Table.Body>
                          {rows.length === 0 ? (
                            <Table.Row>
                              <Table.Cell colSpan={Math.max(columns.length, 1)}>
                                <Text fontSize="sm" color="fg.muted" py={2}>No domains to export.</Text>
                              </Table.Cell>
                            </Table.Row>
                          ) : (
                            rows.map((row, ri) => (
                              <Table.Row key={ri}>
                                {columns.map((_, ci) => (
                                  <Table.Cell
                                    key={ci}
                                    whiteSpace="nowrap"
                                    fontWeight={ci === 0 ? 'medium' : undefined}
                                    color={row[ci] === '' || row[ci] == null ? 'fg.subtle' : undefined}
                                  >
                                    {fmt(row[ci]!)}
                                  </Table.Cell>
                                ))}
                              </Table.Row>
                            ))
                          )}
                        </Table.Body>
                      </Table.Root>
                    )}
                  </Box>
                  {overflow > 0 && (
                    <Text fontSize="xs" color="fg.subtle" mt={2}>
                      Showing first {rows.length} — {overflow} more row{overflow === 1 ? '' : 's'} in the file.
                    </Text>
                  )}
                </Box>
              </VStack>
            </Dialog.Body>

            <Dialog.Footer>
              <Button variant="ghost" onClick={onClose} disabled={busy}>Close</Button>
              <Button colorPalette="brand" onClick={doExport} loading={busy} disabled={!preview || total === 0}>
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
