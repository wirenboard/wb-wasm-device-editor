import { configure } from 'mobx';
import { createRoot } from 'react-dom/client';
import { DeviceSettingsWasm } from './device-settings-wasm';
import { configI18n } from './i18n/config';
import '@/assets/styles/animations.css';
import '@/assets/styles/variables.css';
import '~styles/main.css';
import '~styles/css/bootstrap.min.css';
import '~styles/css/new.css';
import '~styles/css/device-manager.css';

configure({
  enforceActions: 'never',
});

configI18n();

createRoot(document.querySelector('#root')).render(<DeviceSettingsWasm />);

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
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
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
