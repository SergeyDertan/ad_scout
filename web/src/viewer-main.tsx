// Entry point for the shared read-only viewer (VITE_TARGET=viewer).
// The operator console's entry is main.tsx; the two never load each other,
// which is why the viewer can carry its own fonts and its own theme without
// adding a byte to the console's bundle.

// IBM Plex, self-hosted. `wdth.css` carries both the weight and width axes in
// one variable file — the width axis is what sets the condensed column heads
// (see viewer/theme.ts). Only the mono weights actually used are pulled in.
import '@fontsource-variable/ibm-plex-sans/wdth.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ViewerProvider } from './viewer/Provider';
import { ViewerApp } from './viewer/ViewerApp';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ViewerProvider>
      <ViewerApp />
    </ViewerProvider>
  </StrictMode>,
);
