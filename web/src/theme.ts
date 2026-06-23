import { createSystem, defaultConfig, defineConfig } from '@chakra-ui/react';

// ---------------------------------------------------------------------------
// AdScout light theme.
//
// A calm, white operator console: a light-gray canvas (`bg.subtle`) with white
// panels (`bg.panel`) layered on top, an indigo brand accent, and a system
// font stack so it renders crisply offline. We graft a `brand` colorPalette and
// a few global polish rules onto Chakra's stock light tokens — everything else
// is default v3.
// ---------------------------------------------------------------------------

const config = defineConfig({
  theme: {
    keyframes: {
      // Pulsing ring for the "live" connection dot.
      ping: {
        '75%, 100%': { transform: 'scale(2.2)', opacity: '0' },
      },
    },
    tokens: {
      fonts: {
        heading: {
          value:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        },
        body: {
          value:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        },
        mono: {
          value:
            'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
        },
      },
      colors: {
        // Indigo brand ramp.
        brand: {
          50: { value: '#eef2ff' },
          100: { value: '#e0e7ff' },
          200: { value: '#c7d2fe' },
          300: { value: '#a5b4fc' },
          400: { value: '#818cf8' },
          500: { value: '#6366f1' },
          600: { value: '#4f46e5' },
          700: { value: '#4338ca' },
          800: { value: '#3730a3' },
          900: { value: '#312e81' },
          950: { value: '#1e1b4b' },
        },
      },
    },
    semanticTokens: {
      colors: {
        brand: {
          solid: { value: '{colors.brand.600}' },
          contrast: { value: 'white' },
          fg: { value: '{colors.brand.700}' },
          muted: { value: '{colors.brand.100}' },
          subtle: { value: '{colors.brand.50}' },
          emphasized: { value: '{colors.brand.200}' },
          focusRing: { value: '{colors.brand.500}' },
        },
      },
    },
  },
  globalCss: {
    'html, body, #root': {
      // Light-gray canvas; cards/panels sit on top in white.
      bg: 'bg.subtle',
      color: 'fg',
      minHeight: '100%',
    },
    // Tidy default scrollbars to match the light surface.
    '*::-webkit-scrollbar': { width: '10px', height: '10px' },
    '*::-webkit-scrollbar-thumb': {
      bg: 'blackAlpha.200',
      borderRadius: 'full',
      border: '2px solid transparent',
      backgroundClip: 'content-box',
    },
    '*::-webkit-scrollbar-thumb:hover': { bg: 'blackAlpha.300' },
  },
});

export const system = createSystem(defaultConfig, config);
