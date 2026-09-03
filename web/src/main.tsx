import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AuthGate } from './AuthGate';
import { Provider } from './provider';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Provider>
      <AuthGate>
        <App />
      </AuthGate>
    </Provider>
  </StrictMode>,
);
