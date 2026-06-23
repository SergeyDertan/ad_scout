import { EmptyState, VStack, type IconProps } from '@chakra-ui/react';
import type { ComponentType, ReactNode } from 'react';

export function Empty({
  icon: IconEl,
  title,
  description,
  children,
}: {
  icon: ComponentType<IconProps>;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <EmptyState.Root size="md" py={12}>
      <EmptyState.Content>
        <EmptyState.Indicator color="fg.subtle">
          <IconEl boxSize={9} />
        </EmptyState.Indicator>
        <VStack textAlign="center" gap={1}>
          <EmptyState.Title>{title}</EmptyState.Title>
          {description && <EmptyState.Description>{description}</EmptyState.Description>}
        </VStack>
        {children}
      </EmptyState.Content>
    </EmptyState.Root>
  );
}
