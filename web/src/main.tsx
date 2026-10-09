import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';
import { startOutboxSync } from './offline';
import { startStatus } from './status';
import { applyTheme } from './theme';
import './styles.css';

applyTheme();
registerSW({ immediate: true });
startOutboxSync();
startStatus();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
