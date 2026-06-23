import { Center, Spinner } from '@chakra-ui/react';
import type { ReactNode } from 'react';
import { Panel } from './Panel';

/**
 * The shared list surface: a {@link Panel} that shows a spinner on the first
 * load, an empty state when there are no rows, or the content (table) otherwise.
 */
export function DataPanel({
  loading,
  isEmpty,
  empty,
  children,
}: {
  loading: boolean;
  isEmpty: boolean;
  empty: ReactNode;
  children: ReactNode;
}) {
  return (
    <Panel>
      {loading && isEmpty ? (
        <Center py={12}>
          <Spinner color="brand.solid" />
        </Center>
      ) : isEmpty ? (
        empty
      ) : (
        children
      )}
    </Panel>
  );
}
