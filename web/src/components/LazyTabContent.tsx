import { Center, Spinner, Tabs } from '@chakra-ui/react';
import React, { Suspense, type ReactNode } from 'react';

function ViewFallback() {
  return (
    <Center minH="12rem" aria-label="Loading view">
      <Spinner color="brand.solid" />
    </Center>
  );
}

/**
 * Give every lazy tab its own suspense boundary. Visited tabs stay mounted so
 * their filters survive navigation, while the explicit display guard ensures
 * an inactive panel can never participate in page layout.
 */
export function LazyTabContent({
  value,
  active,
  children,
}: {
  value: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <Tabs.Content
      value={value}
      hidden={!active}
      style={{ display: active ? 'block' : 'none' }}
    >
      <Suspense fallback={<ViewFallback />}>{children}</Suspense>
    </Tabs.Content>
  );
}
