import {
  Box,
  Button,
  CloseButton,
  Dialog,
  Field,
  HStack,
  Input,
  Portal,
  Text,
  VStack,
} from '@chakra-ui/react';
import { useMemo, useState } from 'react';
import type { Niche, ResponseRow } from '../types';
import { buildExportModel, defaultHeader, defaultSelection } from '../export/model';
import { exportXlsx } from '../export/xlsx';
import { buildStandaloneHtml, downloadHtml } from '../export/html';
import { toaster, toastError } from './Toaster';
import { DownloadIcon, InboxIcon } from './icons';

/**
 * Export the currently-filtered responses. Two outputs from the same model:
 *   • XLSX — a quick one-click sheet of every price column in the filtered set.
 *   • HTML — a self-contained page that re-filters and re-exports offline, with
 *     per-column selection. The title here is its default (still editable there).
 */
export function ExportDialog({
  rows,
  niches,
  batchName,
  onClose,
}: {
  rows: ResponseRow[];
  niches: Niche[];
  batchName?: string;
  onClose: () => void;
}) {
  const model = useMemo(() => buildExportModel(rows, niches), [rows, niches]);
  const [header, setHeader] = useState(() => defaultHeader(batchName));
  const [busy, setBusy] = useState<'xlsx' | 'html' | null>(null);

  const websites = model.rows.length;
  const priceCols = model.combos.length;
  const empty = websites === 0;

  const doXlsx = async () => {
    setBusy('xlsx');
    try {
      await exportXlsx(model, defaultSelection(model), header);
      toaster.create({ type: 'success', title: 'Spreadsheet downloaded' });
      onClose();
    } catch (e) {
      toastError('Could not build the spreadsheet', e);
    } finally {
      setBusy(null);
    }
  };

  const doHtml = async () => {
    setBusy('html');
    try {
      const html = await buildStandaloneHtml(model, header);
      downloadHtml(html, header);
      toaster.create({ type: 'success', title: 'HTML page downloaded' });
      onClose();
    } catch (e) {
      toastError('Could not build the HTML page', e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(e) => { if (!e.open) onClose(); }} size="md" placement="center">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content rounded="xl">
            <Dialog.Header>
              <Dialog.Title>Export responses</Dialog.Title>
            </Dialog.Header>

            <Dialog.Body>
              <VStack align="stretch" gap={4}>
                <Text fontSize="sm" color="fg.muted">
                  Exports the <b>{websites}</b> website{websites === 1 ? '' : 's'} matching your current
                  filters, one row each with <b>{priceCols}</b> price column{priceCols === 1 ? '' : 's'}{' '}
                  (one per niche).
                </Text>

                <Field.Root>
                  <Field.Label>Title</Field.Label>
                  <Input value={header} onChange={(e) => setHeader(e.target.value)} />
                  <Field.HelperText>
                    Written into the sheet and the HTML page. Editable again inside the HTML.
                  </Field.HelperText>
                </Field.Root>

                <Box borderTopWidth="1px" borderColor="border" pt={4}>
                  <HStack gap={3} align="stretch" flexWrap="wrap">
                    <Button
                      flex="1"
                      minW="40"
                      colorPalette="brand"
                      onClick={doXlsx}
                      loading={busy === 'xlsx'}
                      disabled={empty || busy !== null}
                    >
                      <DownloadIcon /> Download XLSX
                    </Button>
                    <Button
                      flex="1"
                      minW="40"
                      variant="outline"
                      onClick={doHtml}
                      loading={busy === 'html'}
                      loadingText="Bundling…"
                      disabled={empty || busy !== null}
                    >
                      <InboxIcon /> Download HTML page
                    </Button>
                  </HStack>
                  <Text fontSize="xs" color="fg.subtle" mt={2}>
                    XLSX includes every price column. The HTML page lets you re-filter and pick exactly
                    which niches to export before saving an XLSX — all offline.
                  </Text>
                </Box>
              </VStack>
            </Dialog.Body>

            <Dialog.Footer>
              <Button variant="ghost" onClick={onClose} disabled={busy !== null}>
                Close
              </Button>
            </Dialog.Footer>

            <Dialog.CloseTrigger asChild>
              <CloseButton size="sm" disabled={busy !== null} />
            </Dialog.CloseTrigger>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
