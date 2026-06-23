import { ChakraProvider } from '@chakra-ui/react';
import type { ReactNode } from 'react';
import { system } from './theme';
import { Toaster } from './components/Toaster';
import { ConfirmProvider } from './components/Confirm';

export function Provider({ children }: { children: ReactNode }) {
  return (
    <ChakraProvider value={system}>
      <ConfirmProvider>{children}</ConfirmProvider>
      <Toaster />
    </ChakraProvider>
  );
}
