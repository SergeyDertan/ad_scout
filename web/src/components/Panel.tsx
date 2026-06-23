import { Box, type BoxProps } from '@chakra-ui/react';

/** A white surface card on the gray canvas — the standard container for tables/sections. */
export function Panel(props: BoxProps) {
  return (
    <Box
      bg="bg.panel"
      borderWidth="1px"
      borderColor="border"
      rounded="xl"
      boxShadow="xs"
      overflow="hidden"
      {...props}
    />
  );
}
