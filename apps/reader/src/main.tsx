// `./content/zod.js` (imported through the modules below) switches zod's JIT
// off before any schema is built, so the CSP needs no 'unsafe-eval' (C7).
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { entries, loaders } from 'virtual:reader-library';
import { App } from './app/App.js';
import { boot } from './app/boot.js';
import { createContentLoader } from './content/loader.js';
import { stripLaterTickets, takeQrTicket } from './group/deep-link.js';
import { createPastedLinkSignal } from './group/pasted-link.js';
import { safeSessionStorage } from './group/session-store.js';
import './styles/tokens.css';
import './styles/global.css';

// First, before the config, the book, any request or any error screen: take
// a QR ticket out of the fragment and the session history (#24 R3). It is
// kept only in memory and handed to the app once.
const qrLanding = takeQrTicket(window.location, window.history);
// A link pasted later is stripped too; the app only learns that it happened (#25 AC57).
const pastedLinks = createPastedLinkSignal();
stripLaterTickets(window, pastedLinks.notify);

const { config, configIssue, uiLang, route } = boot(
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
      <App
        config={config}
        configIssue={configIssue}
        uiLang={uiLang}
        route={route}
        entries={entries}
        loader={loader}
        storage={safeSessionStorage()}
        qrLanding={qrLanding}
        pastedLinks={pastedLinks}
      />
    </StrictMode>,
  );
}
