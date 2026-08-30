import { configure } from 'mobx';
import { createRoot } from 'react-dom/client';
import { topicCopyPolicy } from '@/components/cell/topic-copy-policy';
import { daliHostCapabilities } from '@/stores/dali/host-capabilities';
import { App } from './app';
import { configI18n } from './i18n/config';
import 'glyphicons-only-bootstrap/css/bootstrap.min.css';
import 'bootstrap/dist/css/bootstrap-grid.min.css';
import '@/assets/styles/index.css';

configure({
  enforceActions: 'never',
});

configI18n();

// Clicking a cell's name in homeui copies its MQTT topic — useful on a
// controller, where rules and dashboards take topics. This editor has no
// broker; the runtime view and the DALI controls drive cells locally, and
// "wb-dali_17_bus_1_0/error_status copied to clipboard" is a toast with no
// possible next step.
topicCopyPolicy.enabled = false;

// A controller host copies monitor rows to syslog; this build has no syslog.
daliHostCapabilities.syslogMonitor = false;
// The Lunatone-gateway emulator is a WebSocket *server* — a browser page
// cannot listen on a port, so the toggle would only mislead.
daliHostCapabilities.lunatoneEmulator = false;

// homeui's CSS variables are scoped to [data-theme='light'|'dark'] on the root
// element, and in homeui it is uiStore that puts the attribute there. This app
// never runs that store, and without the attribute every var(--...) inside the
// homeui components it embeds resolves to nothing — most visibly the console
// panel, whose background simply disappears.
const applyTheme = (dark: boolean) =>
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
const colorScheme = window.matchMedia('(prefers-color-scheme: dark)');
applyTheme(colorScheme.matches);
colorScheme.addEventListener('change', (event) => applyTheme(event.matches));

createRoot(document.querySelector('#root')).render(<App />);

// Update detection: the Vite build plugin (swCachePlugin in vite.config.ts) injects
// hashed asset filenames into sw.js at build time. Any code change produces different
// asset hashes, which changes sw.js content. The browser compares sw.js byte-by-byte
// on each update() call — if different, it installs the new SW, which calls skipWaiting()
// to activate immediately, triggering the controllerchange event below.
//
// On page load, the network-first navigation strategy already serves the latest HTML
// (with 3s timeout fallback to cache). So the initial register() may update the SW,
// but the page already has fresh content — no reload needed. We only notify about
// updates detected by the periodic 60s polling (mid-session deployments).
if (
  import.meta.env.PROD &&
  'serviceWorker' in navigator &&
  location.protocol !== 'file:'
) {
  let periodicUpdateStarted = false;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      setInterval(() => {
        periodicUpdateStarted = true;
        reg.update();
      }, 60000);
    });
  });

  let initialController = navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (initialController && periodicUpdateStarted) {
      window.dispatchEvent(new Event('sw-update-available'));
    }
    initialController = navigator.serviceWorker.controller;
  });
}
