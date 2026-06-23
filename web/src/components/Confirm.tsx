import { Button, CloseButton, Dialog, Portal } from '@chakra-ui/react';
import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from 'react';

interface ConfirmOptions {
  title?: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

const ConfirmContext = createContext<(opts: ConfirmOptions) => Promise<boolean>>(() =>
  Promise.resolve(false),
);

/** Returns `confirm(opts) => Promise<boolean>` — a styled replacement for window.confirm. */
export function useConfirm() {
  return useContext(ConfirmContext);
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState<ConfirmOptions>({});
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback((o: ConfirmOptions) => {
    setOpts(o);
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = (result: boolean) => {
    setOpen(false);
    resolver.current?.(result);
    resolver.current = null;
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog.Root
        role="alertdialog"
        open={open}
        onOpenChange={(e) => {
          if (!e.open) settle(false);
        }}
        placement="center"
        motionPreset="scale"
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content rounded="xl">
              <Dialog.Header>
                <Dialog.Title>{opts.title ?? 'Are you sure?'}</Dialog.Title>
              </Dialog.Header>
              {opts.description != null && (
                <Dialog.Body color="fg.muted">{opts.description}</Dialog.Body>
              )}
              <Dialog.Footer gap={2}>
                <Button variant="outline" onClick={() => settle(false)}>
                  {opts.cancelLabel ?? 'Cancel'}
                </Button>
                <Button
                  colorPalette={opts.destructive ? 'red' : 'brand'}
                  onClick={() => settle(true)}
                >
                  {opts.confirmLabel ?? 'Confirm'}
                </Button>
              </Dialog.Footer>
              <Dialog.CloseTrigger asChild>
                <CloseButton size="sm" />
              </Dialog.CloseTrigger>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </ConfirmContext.Provider>
  );
}
