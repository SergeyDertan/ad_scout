import { createSystem, defaultConfig, defineConfig } from '@chakra-ui/react';
import { tableAnatomy } from '@chakra-ui/react/anatomy';

// ---------------------------------------------------------------------------
// The viewer's own look: "quote sheet".
//
// This theme belongs to the Firebase-hosted viewer ONLY. The operator console
// keeps src/theme.ts; the two are never loaded together (separate entries, see
// viewer-main.tsx vs main.tsx), so they can look like different instruments
// without either constraining the other.
//
// The thesis: this is a price book, and in a price book colour is data. So the
// chassis — page, panels, rules, type, buttons — is white and black with a
// neutral grey between them, and every chromatic pixel on screen carries
// meaning: green is "yes, they'll take the post", amber is a sensitive niche,
// gold is a price carried over from an older quote, violet is a special, red is
// excluded. Nothing is tinted for decoration, which is what makes a scan across
// a table readable.
//
// The page itself is plain white; structure comes from hairlines and a single
// pale grey used for table heads, zebra rows and hovers.
//
// Two typefaces, three roles:
//   IBM Plex Sans          prose and labels
//   IBM Plex Sans @ 80%    the same variable font at a condensed width, for
//                          dense column headers (see the table recipe below)
//   IBM Plex Mono          every figure, stamp and badge — money lines up,
//                          zeroes are slashed, and the data reads as data
//
// Everything else is Chakra v3 defaults.
// ---------------------------------------------------------------------------

const SANS = "'IBM Plex Sans Variable', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
const MONO = "'IBM Plex Mono', ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";

const config = defineConfig({
  theme: {
    keyframes: {
      // The sign-in specimen deals itself out, one row at a time. Reduced
      // motion collapses it (see globalCss) — the rows just appear.
      rise: {
        from: { opacity: '0', transform: 'translateY(6px)' },
        to: { opacity: '1', transform: 'translateY(0)' },
      },
    },
    tokens: {
      fonts: {
        heading: { value: SANS },
        body: { value: SANS },
        mono: { value: MONO },
      },

      colors: {
        // --- the chassis -----------------------------------------------------
        // A plain neutral ramp, a hair cool so it reads as clean white rather
        // than as an off-white tint. Every surface, rule and label in the app
        // comes from these eleven steps.
        gray: {
          50: { value: '#f7f8f9' },
          100: { value: '#eef0f2' },
          200: { value: '#e3e6e9' },
          300: { value: '#cdd2d7' },
          400: { value: '#a4acb4' },
          500: { value: '#7d858e' },
          600: { value: '#5c646d' },
          700: { value: '#464d55' },
          800: { value: '#31373d' },
          900: { value: '#1f242a' },
          950: { value: '#12161a' },
        },

        // The house ink: black, near enough. Buttons, the wordmark and the
        // active segment are the only places it appears as a fill.
        brand: {
          50: { value: '#f2f3f5' },
          100: { value: '#e4e6e9' },
          200: { value: '#c8ccd2' },
          300: { value: '#9aa1a9' },
          400: { value: '#6b727a' },
          500: { value: '#464c53' },
          600: { value: '#2f353b' },
          700: { value: '#20252a' },
          800: { value: '#16191d' },
          900: { value: '#0e1114' },
          950: { value: '#070809' },
        },

        // --- the data colours ------------------------------------------------
        // One family, tuned to sit on white: clear at badge size, dark enough at
        // 700 to pass contrast on their own 100 tint. Overriding the RAMPS
        // (rather than every call site) is what re-skins the shared
        // DomainsView/ResponsesView badges for free — Chakra derives
        // `green.subtle`, `green.fg`, `green.solid` etc. from these, and every
        // `colorPalette="green"` in the app follows.

        // yes / affirmative
        green: {
          50: { value: '#ecf7f0' },
          100: { value: '#d5eede' },
          200: { value: '#a8dcbe' },
          300: { value: '#71c497' },
          400: { value: '#3fa670' },
          500: { value: '#1f8a52' },
          600: { value: '#177042' },
          700: { value: '#125935' },
          800: { value: '#0f4529' },
          900: { value: '#0a331e' },
          950: { value: '#051f12' },
        },
        // sensitive niche
        orange: {
          50: { value: '#fef4e6' },
          100: { value: '#fde7c7' },
          200: { value: '#f9cd8c' },
          300: { value: '#f2ad4c' },
          400: { value: '#e08c00' },
          500: { value: '#c47600' },
          600: { value: '#a15f00' },
          700: { value: '#7d4a00' },
          800: { value: '#5e3800' },
          900: { value: '#442800' },
          950: { value: '#281800' },
        },
        // excluded / failed
        red: {
          50: { value: '#fdefee' },
          100: { value: '#fbdcda' },
          200: { value: '#f5b7b1' },
          300: { value: '#ec8b82' },
          400: { value: '#df5c50' },
          500: { value: '#cc3a2c' },
          600: { value: '#ab2c20' },
          700: { value: '#89231a' },
          800: { value: '#681b14' },
          900: { value: '#4b130e' },
          950: { value: '#2c0b08' },
        },
        // special offer / opted out
        purple: {
          50: { value: '#f3f0fd' },
          100: { value: '#e7e1fb' },
          200: { value: '#cec3f6' },
          300: { value: '#ae9def' },
          400: { value: '#8f78e5' },
          500: { value: '#7358d6' },
          600: { value: '#5c44b4' },
          700: { value: '#493691' },
          800: { value: '#38296f' },
          900: { value: '#291e51' },
          950: { value: '#181230' },
        },
        // price carried over from an older quote
        yellow: {
          50: { value: '#fdf5e0' },
          100: { value: '#fbeabd' },
          200: { value: '#f4d477' },
          300: { value: '#e3b93a' },
          400: { value: '#c99c0f' },
          500: { value: '#ac840a' },
          600: { value: '#8c6b08' },
          700: { value: '#6d5306' },
          800: { value: '#523e05' },
          900: { value: '#3b2d03' },
          950: { value: '#231a02' },
        },
        // attributed to a site named in the message
        blue: {
          50: { value: '#eaf2fd' },
          100: { value: '#d6e5fb' },
          200: { value: '#accaf5' },
          300: { value: '#7aa8ec' },
          400: { value: '#4b86df' },
          500: { value: '#2b68cb' },
          600: { value: '#2153a8' },
          700: { value: '#1b4285' },
          800: { value: '#153264' },
          900: { value: '#0f2549' },
          950: { value: '#08162b' },
        },
      },

      radii: {
        // Slightly crisper than stock: this is an instrument, not a card wall.
        l1: { value: '3px' },
        l2: { value: '5px' },
        l3: { value: '9px' },
      },

      shadows: {
        // Shallow and neutral. On a white page a card is defined by its
        // hairline; the shadow only lifts it off the surface a little.
        xs: { value: '0 1px 2px rgba(18, 22, 26, 0.05)' },
        sm: { value: '0 1px 3px rgba(18, 22, 26, 0.07), 0 1px 2px rgba(18, 22, 26, 0.04)' },
        md: { value: '0 4px 12px -2px rgba(18, 22, 26, 0.09)' },
        lg: { value: '0 12px 32px -8px rgba(18, 22, 26, 0.14)' },
      },
    },

    semanticTokens: {
      colors: {
        // White page, white panels. `bg.subtle` is the one grey that carries
        // structure — table heads, zebra rows, hovers — so a panel reads as a
        // panel without a second background colour behind it.
        bg: {
          DEFAULT: { value: '#ffffff' },
          subtle: { value: '{colors.gray.50}' },
          muted: { value: '{colors.gray.100}' },
          emphasized: { value: '{colors.gray.200}' },
          panel: { value: '#ffffff' },
        },
        fg: {
          DEFAULT: { value: '{colors.gray.950}' },
          muted: { value: '{colors.gray.600}' },
          subtle: { value: '{colors.gray.500}' },
        },
        border: {
          DEFAULT: { value: '{colors.gray.200}' },
          muted: { value: '{colors.gray.100}' },
          subtle: { value: '{colors.gray.50}' },
          emphasized: { value: '{colors.gray.300}' },
        },
        brand: {
          solid: { value: '{colors.brand.800}' },
          contrast: { value: '#ffffff' },
          fg: { value: '{colors.brand.800}' },
          muted: { value: '{colors.brand.100}' },
          subtle: { value: '{colors.brand.50}' },
          emphasized: { value: '{colors.brand.200}' },
          focusRing: { value: '{colors.brand.500}' },
        },
      },
    },

    recipes: {
      heading: {
        base: {
          fontFamily: 'heading',
          fontWeight: '600',
          letterSpacing: '-0.02em',
        },
      },

      // Every badge in the viewer is a fact about a price — sensitive, expired,
      // carried over, excluded. Setting them all as small mono stamps gives the
      // data one voice, and reads as a marking on a sheet rather than a pill on
      // a dashboard.
      badge: {
        base: {
          fontFamily: 'mono',
          fontWeight: '500',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          borderRadius: '3px',
        },
      },

      button: {
        base: {
          fontWeight: '500',
          letterSpacing: '0.01em',
        },
      },
    },

    slotRecipes: {
      table: {
        slots: tableAnatomy.keys(),
        base: {
          // Condensed, tracked, uppercase column heads — the one place the
          // variable font's width axis earns its keep.
          columnHeader: {
            fontFamily: 'body',
            fontStretch: '80%',
            fontSize: '11px',
            lineHeight: '1.4',
            fontWeight: '600',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color: 'fg.muted',
          },
        },
      },
    },
  },

  globalCss: {
    'html, body, #root': {
      bg: 'bg',
      color: 'fg',
      minHeight: '100%',
    },
    body: {
      // Figures line up in columns everywhere, not just inside <table>.
      fontVariantNumeric: 'lining-nums tabular-nums',
    },
    '::selection': {
      bg: 'brand.200',
      color: 'brand.900',
    },
    '*::-webkit-scrollbar': { width: '10px', height: '10px' },
    '*::-webkit-scrollbar-thumb': {
      bg: 'gray.300',
      borderRadius: 'full',
      border: '2px solid transparent',
      backgroundClip: 'content-box',
    },
    '*::-webkit-scrollbar-thumb:hover': { bg: 'gray.400' },
    '*, *::before, *::after': {
      '@media (prefers-reduced-motion: reduce)': {
        animationDuration: '0.01ms !important',
        animationIterationCount: '1 !important',
        transitionDuration: '0.01ms !important',
      },
    },
  },
});

export const viewerSystem = createSystem(defaultConfig, config);
