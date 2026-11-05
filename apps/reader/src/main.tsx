// `./content/zod.js` (imported through the modules below) switches zod's JIT
// off before any schema is built, so the CSP needs no 'unsafe-eval' (C7).
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { entries, loaders } from 'virtual:reader-library';
import { App } from './app/App.js';
import { boot } from './app/boot.js';
import { createContentLoader } from './content/loader.js';
import './styles/tokens.css';
import './styles/global.css';

const { config, uiLang, route } = boot(
  document,
  navigator.languages,
  window.location,
  entries.map((entry) => entry.contentId),
);

const loader = config
  ? createContentLoader({
      bundled: loaders,
      config: {
        srcOrigins: config.srcOrigins,
        fetchTimeoutSeconds: config.fetchTimeoutSeconds,
        srcMaxBytes: config.srcMaxBytes,
      },
    })
  : null;

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <App config={config} uiLang={uiLang} route={route} entries={entries} loader={loader} />
    </StrictMode>,
  );
}
