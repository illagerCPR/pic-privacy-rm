import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { I18nProvider } from './i18n/index.tsx';
import { applyStoredTheme } from './lib/theme.ts';
import './styles/global.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

// Before the first render: a visitor who picked the opposite of their OS theme
// should not see the page start out in the wrong palette.
applyStoredTheme();

// Offline support: the built app keeps working without a network. In dev the
// worker would only cache HMR modules, so it is production-only.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js').catch(() => {
      /* offline support is a bonus, never a requirement */
    });
  });
}

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
);
