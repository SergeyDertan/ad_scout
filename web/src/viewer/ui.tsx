import { Box, HStack, Text, type BoxProps, type TextProps } from '@chakra-ui/react';

// The viewer's small vocabulary of house parts. Three of them, deliberately:
// the mono label that marks every piece of metadata, the wordmark, and the
// segmented control. Anything more and the chassis starts competing with the
// data it exists to frame.

/**
 * A mono, tracked, uppercase label — the viewer's voice for anything that is
 * *about* the data rather than the data itself: column heads, stamps, counts,
 * field names.
 */
export function Mono(props: TextProps) {
  return (
    <Text
      fontFamily="mono"
      fontSize="11px"
      lineHeight="1.5"
      fontWeight="500"
      textTransform="uppercase"
      letterSpacing="0.1em"
      color="fg.muted"
      {...props}
    />
  );
}

/** Hairline divider, drawn in the same ink as the table rules. */
export function Rule(props: BoxProps) {
  return <Box height="1px" bg="border" flex="1" {...props} />;
}

export function Wordmark({ size = 'sm' }: { size?: 'sm' | 'lg' }) {
  const lg = size === 'lg';
  return (
    <HStack gap={lg ? 3 : 2.5} align="baseline">
      <Text
        fontFamily="mono"
        fontWeight="600"
        fontSize={lg ? '20px' : '15px'}
        letterSpacing="0.2em"
        // Tracking adds a trailing gap after the last letter; pull it back so
        // the lockup sits square against what follows.
        mr="-0.2em"
        color="fg"
      >
        ADSCOUT
      </Text>
      <Mono
        fontSize={lg ? '11px' : '10px'}
        color="fg.subtle"
        fontStretch="80%"
        display={lg ? 'block' : { base: 'none', sm: 'block' }}
      >
        price book
      </Mono>
    </HStack>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** Fill when this segment is the active one. Defaults to the ink. */
  activeBg?: string;
  /** Label colour when active. Defaults to paper, to sit on the ink. */
  activeFg?: string;
  title?: string;
}

/**
 * A three-way choice rendered as one ruled block rather than three buttons.
 *
 * Used for the sensitivity call in NichesPanel, where the three answers are a
 * single decision with a default-less middle state — separate buttons made it
 * look like three independent actions.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (next: T) => void;
  ariaLabel: string;
}) {
  return (
    <HStack
      role="group"
      aria-label={ariaLabel}
      gap={0}
      borderWidth="1px"
      borderColor="border.emphasized"
      rounded="l1"
      overflow="hidden"
      bg="bg.panel"
      flexShrink={0}
    >
      {options.map((o, i) => {
        const active = o.value === value;
        return (
          <Box
            as="button"
            key={o.value}
            {...{ type: 'button', 'aria-pressed': active }}
            title={o.title}
            onClick={() => onChange(o.value)}
            px={2.5}
            py="5px"
            fontFamily="mono"
            fontSize="10px"
            fontWeight="500"
            textTransform="uppercase"
            letterSpacing="0.08em"
            cursor="pointer"
            borderLeftWidth={i === 0 ? undefined : '1px'}
            borderColor="border.emphasized"
            bg={active ? o.activeBg ?? 'brand.solid' : 'transparent'}
            color={active ? o.activeFg ?? 'brand.contrast' : 'fg.muted'}
            transition="background 0.12s, color 0.12s"
            _hover={active ? undefined : { bg: 'bg.subtle', color: 'fg' }}
            _focusVisible={{ outline: '2px solid', outlineColor: 'brand.focusRing', outlineOffset: '-2px' }}
          >
            {o.label}
          </Box>
        );
      })}
    </HStack>
  );
}
