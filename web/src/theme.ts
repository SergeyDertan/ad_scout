import { createSystem, defaultConfig, defineConfig } from '@chakra-ui/react';

// Dark-by-default look (the page sets `<html class="dark">`). We only graft a
// global background/foreground onto Chakra's default system; everything else is
// stock v3 tokens.
const config = defineConfig({
  globalCss: {
    'html, body, #root': {
      bg: 'bg',
      color: 'fg',
      minHeight: '100%',
    },
  },
});

export const system = createSystem(defaultConfig, config);
