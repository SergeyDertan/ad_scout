import { Badge, Box, Button, Flex, Grid, GridItem, HStack, Stack, Text, VStack } from '@chakra-ui/react';
import type { ReactNode } from 'react';
import { Mono, Rule, Wordmark } from './ui';

// ---------------------------------------------------------------------------
// Everything shown before there is data on screen: the sign-in hero, and the
// two dead ends (no Firebase project in the build, account not on the
// allowlist). They share one frame so the viewer never changes shape under you.
// ---------------------------------------------------------------------------

/** Wordmark pinned top-left, everything else optically centred in what's left. */
function Frame({ children }: { children: ReactNode }) {
  return (
    <Flex minH="100dvh" direction="column" bg="bg" px={{ base: 5, md: 10 }} py={{ base: 6, md: 8 }}>
      <Box maxW="6xl" w="full" mx="auto">
        <Wordmark />
      </Box>
      <Flex flex="1" align="center" py={{ base: 10, md: 12 }}>
        <Box maxW="6xl" w="full" mx="auto">
          {children}
        </Box>
      </Flex>
    </Flex>
  );
}

/**
 * A dead end: says what is wrong and what to do about it. No illustration —
 * these screens are not a place to linger.
 */
export function Notice({
  eyebrow,
  title,
  children,
  action,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Frame>
      <VStack align="flex-start" gap={4} maxW="lg">
        <Mono color="fg.subtle">{eyebrow}</Mono>
        <Text fontSize={{ base: '28px', md: '34px' }} fontWeight="600" letterSpacing="-0.02em" lineHeight="1.15">
          {title}
        </Text>
        <Text color="fg.muted" fontSize="sm" lineHeight="1.7">
          {children}
        </Text>
        {action}
      </VStack>
    </Frame>
  );
}

// --- the specimen -----------------------------------------------------------

/** Illustrative rows. Labelled as examples on screen and built from reserved
 *  example.* domains so they can never be mistaken for real quotes. */
const SPECIMEN: {
  site: string;
  niche: string;
  price: string;
  tier: 'reg' | 'sens' | 'unknown';
  /** Not their own quote — worked out from what they charge for comparable niches. */
  inferred?: boolean;
  /** They said no to this niche. */
  refused?: boolean;
}[] = [
  { site: 'example.com', niche: 'casino', price: '$420', tier: 'sens' },
  { site: 'news.example.org', niche: 'crypto', price: '$260', tier: 'sens' },
  { site: 'example.net', niche: 'general', price: '$95', tier: 'reg' },
  { site: 'blog.example.io', niche: 'finance', price: '~$180', tier: 'reg', inferred: true },
  { site: 'shop.example.co', niche: 'cbd', price: '—', tier: 'unknown', refused: true },
];

// Narrow screens drop the niche column and fold the niche under the site, so
// the sheet never pushes the page wider than the phone.
const SHEET_COLS = { base: '1fr 76px', sm: '1fr 168px 76px' };
const NICHE_COL = { base: 'none', sm: 'flex' };

function NicheCell({ row }: { row: (typeof SPECIMEN)[number] }) {
  return (
    <HStack gap={1.5} minW={0}>
      <Text fontSize="sm" color="fg.muted" truncate>
        {row.niche}
      </Text>
      {row.tier === 'sens' && (
        <Badge colorPalette="orange" variant="surface" size="sm">
          sensitive
        </Badge>
      )}
      {row.tier === 'unknown' && (
        <Badge colorPalette="gray" variant="surface" size="sm">
          unknown
        </Badge>
      )}
    </HStack>
  );
}

function Specimen() {
  return (
    <Box borderWidth="1px" borderColor="border" rounded="l3" bg="bg.panel" boxShadow="md" overflow="hidden">
      <HStack px={4} py={2.5} borderBottomWidth="1px" borderColor="border" bg="bg.subtle" gap={3}>
        <Mono color="fg.subtle" flexShrink={0}>
          example sheet
        </Mono>
        <Rule />
      </HStack>

      <Box
        display="grid"
        gridTemplateColumns={SHEET_COLS}
        gap={3}
        px={4}
        py={2}
        borderBottomWidth="1px"
        borderColor="border"
      >
        <Mono fontSize="10px">site</Mono>
        <Mono fontSize="10px" display={NICHE_COL}>
          niche
        </Mono>
        <Mono fontSize="10px" textAlign="right">
          price
        </Mono>
      </Box>

      {SPECIMEN.map((r, i) => (
        <Box
          key={r.site}
          display="grid"
          gridTemplateColumns={SHEET_COLS}
          gap={3}
          alignItems="center"
          px={4}
          py={2.5}
          borderBottomWidth={i === SPECIMEN.length - 1 ? undefined : '1px'}
          borderColor="border.muted"
          animationName="rise"
          animationDuration="0.5s"
          animationTimingFunction="ease-out"
          animationFillMode="both"
          style={{ animationDelay: `${180 + i * 70}ms` }}
        >
          <Box minW={0}>
            <Text fontSize="sm" truncate>
              {r.site}
            </Text>
            <Box display={{ base: 'block', sm: 'none' }} mt={0.5}>
              <NicheCell row={r} />
            </Box>
          </Box>
          <HStack gap={1.5} minW={0} display={NICHE_COL}>
            <NicheCell row={r} />
          </HStack>
          <Text
            fontFamily="mono"
            fontSize="sm"
            fontWeight={r.refused ? '400' : '500'}
            textAlign="right"
            color={r.refused ? 'fg.subtle' : 'fg'}
            title={r.inferred ? 'Inferred from what this site charges for comparable niches' : undefined}
          >
            {r.price}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

// --- the hero ---------------------------------------------------------------

export function SignIn({ onSignIn, busy }: { onSignIn: () => void; busy?: boolean }) {
  return (
    <Frame>
      <Grid templateColumns={{ base: '1fr', lg: '1.05fr 1fr' }} gap={{ base: 12, lg: 16 }} alignItems="center">
        <GridItem>
          <Stack gap={6} maxW="620px">
            <Text
              fontSize={{ base: '30px', sm: '34px', md: '44px', xl: '50px' }}
              fontWeight="600"
              letterSpacing="-0.03em"
              lineHeight="1.05"
              textWrap="balance"
            >
              Every price a publisher has quoted you.
            </Text>

            <Text color="fg.muted" fontSize="md" lineHeight="1.7" maxW="30rem">
              One sheet per site: what they charge, for which niches, and the email the number came from. Read-only —
              nothing here sends, edits or deletes.
            </Text>

            <Box pt={1}>
              <Button colorPalette="brand" size="lg" onClick={onSignIn} loading={busy} px={6}>
                Sign in with Google
              </Button>
            </Box>

            <Stack gap={2.5} pt={4} maxW="30rem">
              <HStack gap={3}>
                <Mono color="fg.subtle" flexShrink={0}>
                  access by allowlist
                </Mono>
                <Rule />
              </HStack>
              <Text color="fg.subtle" fontSize="xs" lineHeight="1.6">
                Use the Google account you were given access with. Any other account will sign in and see nothing.
              </Text>
            </Stack>
          </Stack>
        </GridItem>

        <GridItem>
          <Specimen />
          <Text color="fg.subtle" fontSize="xs" mt={3} textAlign={{ base: 'start', lg: 'end' }}>
            Example rows. Your sheets load once you sign in.
          </Text>
        </GridItem>
      </Grid>
    </Frame>
  );
}
