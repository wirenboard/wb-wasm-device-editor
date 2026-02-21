import path from 'path';
import { test, expect } from '@playwright/test';
import { loadAppWithSW } from './helpers';
import { TestServer } from './test-server';

const DIST_DIR = path.resolve(__dirname, '..', 'dist-configurator');

let server: TestServer;

test.beforeEach(async () => {
  server = new TestServer(DIST_DIR);
  await server.start();
});

test.afterEach(async () => {
  await server.stop().catch(() => {});
});

test('serves cached page and shows offline indicator when server is down', async ({
  page,
  context,
}) => {
  // 1. Load app, wait for SW activation (assets get cached)
  await loadAppWithSW(page, context);

  // 2. Stop the server (real network failure, not DevTools offline)
  await server.stop();

  // 3. Reload — SW intercepts navigation, serves cached index.html
  await page.reload({ waitUntil: 'load' });

  // 4. Assert page renders from cache
  await expect(page).toHaveTitle('Wiren Board Device Editor');

  // 5-6. The component's checkOnline() runs on mount (controller is set),
  //       fetches /sw-ping → SW tries HEAD /manifest.json → fails → returns 'offline'
  //       → setIsOffline(true) → offline indicator appears
  await expect(page.locator('.deviceSettingsWasm-offline')).toBeVisible({
    timeout: 10_000,
  });

  // 7. Restart server, trigger online check, offline indicator disappears
  await server.start();
  // Dispatch 'online' event to trigger checkOnline() immediately
  // (instead of waiting for the 30s interval)
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('.deviceSettingsWasm-offline')).not.toBeVisible({
    timeout: 10_000,
  });
});
