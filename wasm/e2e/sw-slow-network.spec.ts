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
  server.setDelay(0);
  await server.stop().catch(() => {});
});

test('SW serves cached page within 3s when server is slow', async ({
  page,
  context,
}) => {
  // 1. Load app, wait for SW activation (all assets get cached)
  await loadAppWithSW(page, context);

  // 2. Set server delay to 5000ms (server-side throttling)
  server.setDelay(5000);

  // 3. Reload and measure time to first response byte.
  //    SW's navigation strategy: network-first with 3s timeout, then cache fallback.
  //    Server responds in 5s, but SW gives up after 3s and serves cached page.
  //    Using 'commit' (response received) instead of 'load' to measure only
  //    the navigation response time, not sub-resource loading.
  const start = Date.now();
  await page.reload({ waitUntil: 'commit' });
  const elapsed = Date.now() - start;

  // 4. Assert response arrived in ~3s (SW timeout), not 5s (server delay)
  expect(elapsed).toBeLessThan(4500);

  // 5. Assert page content is correct (served from cache)
  await expect(page).toHaveTitle('Wiren Board Device Editor');

  // 6. Restore delay to 0, reload, assert fast
  server.setDelay(0);
  const start2 = Date.now();
  await page.reload({ waitUntil: 'commit' });
  const elapsed2 = Date.now() - start2;
  expect(elapsed2).toBeLessThan(3500);
});
