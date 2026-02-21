import path from 'path';
import { test, expect } from '@playwright/test';
import { BASE_URL, waitForSWActivated, mutateSWVersion } from './helpers';
import { TestServer } from './test-server';

const DIST_DIR = path.resolve(__dirname, '..', 'dist-configurator');
const SW_PATH = path.join(DIST_DIR, 'sw.js');

let server: TestServer;

test.beforeEach(async () => {
  server = new TestServer(DIST_DIR);
  await server.start();
});

test.afterEach(async () => {
  await server.stop().catch(() => {});
});

test('shows update notification when SW detects new version', async ({
  browser,
}) => {
  // Create a fresh context with patched setInterval:
  // The app uses setInterval(fn, 60000) for periodic SW update checks.
  // We patch it to 100ms so the test doesn't wait 60s.
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const orig = window.setInterval.bind(window);
    (window as any).setInterval = (fn: Function, delay: number, ...args: any[]) => {
      if (delay === 60000) return orig(fn, 100, ...args);
      return orig(fn, delay, ...args);
    };
  });

  const page = await context.newPage();

  // 1. Load app, wait for SW activation
  await page.goto(BASE_URL, { waitUntil: 'load' });
  await waitForSWActivated(page, context);

  // 2. Wait for WASM module to initialize — the update banner lives inside
  //    PageLayout's actions prop, which only renders when isLoading is false.
  //    WASM init may intermittently stall under resource pressure, so retry.
  const addDeviceButton = page.getByRole('button', { name: 'Manually add device' });
  try {
    await expect(addDeviceButton).toBeVisible({ timeout: 20_000 });
  } catch {
    await page.reload({ waitUntil: 'load' });
    await waitForSWActivated(page, context);
    await expect(addDeviceButton).toBeVisible({ timeout: 30_000 });
  }

  // 3. Confirm no update banner initially
  await expect(page.locator('.deviceSettingsWasm-update')).not.toBeVisible();

  // 3. Mutate CACHE_VERSION in sw.js on disk (simulates a new deployment)
  const restore = mutateSWVersion(SW_PATH);

  try {
    // 4-5. The patched 100ms interval calls reg.update() → browser detects
    //       changed sw.js → installs new SW → skipWaiting() → controllerchange
    //       → periodicUpdateStarted is true → sw-update-available event → UI shows banner
    await expect(page.locator('.deviceSettingsWasm-update')).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    // 6. Cleanup: restore original sw.js
    restore();
    await context.close();
  }
});
