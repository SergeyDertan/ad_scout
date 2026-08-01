import { ChakraProvider } from '@chakra-ui/react';
import type { ReactNode } from 'react';
import { ConfirmProvider } from '../components/Confirm';
import { Toaster } from '../components/Toaster';
import { viewerSystem } from './theme';

/**
 * The viewer's provider. Identical in shape to src/provider.tsx but wired to
 * the viewer's own design system, so the console's theme and this one can move
 * independently. The shared views still reach for toasts and confirms (export
 * dialogs, mostly), so both stay mounted.
 */
export function ViewerProvider({ children }: { children: ReactNode }) {
  return (
    <ChakraProvider value={viewerSystem}>
      <ConfirmProvider>{children}</ConfirmProvider>
      <Toaster />
    </ChakraProvider>
  );
}
