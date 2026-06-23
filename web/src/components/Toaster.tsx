import {
  Toaster as ChakraToaster,
  Portal,
  Spinner,
  Stack,
  Toast,
  createToaster,
} from '@chakra-ui/react';

// App-wide toaster. Import `toaster` anywhere and call `toaster.create({...})`
// to surface success/error feedback for an action.
export const toaster = createToaster({
  placement: 'bottom-end',
  pauseOnPageIdle: true,
  max: 4,
});

export function Toaster() {
  return (
    <Portal>
      <ChakraToaster toaster={toaster} insetInline={{ mdDown: '4' }}>
        {(toast) => (
          <Toast.Root width={{ md: 'sm' }} boxShadow="lg">
            {toast.type === 'loading' ? (
              <Spinner size="sm" color="brand.solid" />
            ) : (
              <Toast.Indicator />
            )}
            <Stack gap="1" flex="1" maxWidth="100%">
              {toast.title != null && <Toast.Title>{toast.title}</Toast.Title>}
              {toast.description != null && (
                <Toast.Description>{toast.description}</Toast.Description>
              )}
            </Stack>
            {toast.action && <Toast.ActionTrigger>{toast.action.label}</Toast.ActionTrigger>}
            {toast.closable && <Toast.CloseTrigger />}
          </Toast.Root>
        )}
      </ChakraToaster>
    </Portal>
  );
}

/** Show a thrown error as an error toast, returning its message. */
export function toastError(title: string, e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  toaster.create({ type: 'error', title, description: message });
  return message;
}
