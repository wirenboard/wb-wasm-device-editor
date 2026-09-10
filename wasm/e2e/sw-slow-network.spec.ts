import path from 'path';
import { test, expect, type Page } from '@playwright/test';
import { loadAppWithSW } from './helpers';
import { TestServer } from './test-server';

const DIST_DIR = path.resolve(__dirname, '..', 'dist-configurator');
const SERVER_DELAY = 5000;

let server: TestServer;

test.beforeEach(async () => {
  server = new TestServer(DIST_DIR);
  await server.start();
});

test.afterEach(async () => {
  server.setDelay(0);
  await server.stop().catch(() => {});
});

async function assertControlled(page: Page): Promise<void> {
  const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
  expect(controlled, 'page must be controlled by the SW before the reload').toBe(true);
}

test('SW serves the cached page when the server is slow', async ({
  page,
  context,
}) => {
  await loadAppWithSW(page, context);
  await assertControlled(page);

  server.setDelay(SERVER_DELAY);

  const start = Date.now();
  const response = await page.reload({ waitUntil: 'commit' });
  const elapsed = Date.now() - start;

  expect(response).not.toBeNull();
  expect(response!.headers()['x-sw-source']).toBe('cache');
  expect(elapsed).toBeLessThan(SERVER_DELAY);
  await expect(page).toHaveTitle('Wiren Board Device Editor');

  server.setDelay(0);
  const fresh = await page.reload({ waitUntil: 'commit' });
  expect(fresh!.headers()['x-sw-source']).toBeUndefined();
  await expect(page).toHaveTitle('Wiren Board Device Editor');
});

test('SW waits for the slow network when the cached page is gone', async ({
  page,
  context,
}) => {
  await loadAppWithSW(page, context);
  await assertControlled(page);

  await page.evaluate(async () => {
    for (const key of await caches.keys()) {
      const cache = await caches.open(key);
      await cache.delete('/');
    }
  });

  server.setDelay(SERVER_DELAY);
  const response = await page.reload({ waitUntil: 'commit' });
  server.setDelay(0);

  expect(response).not.toBeNull();
  expect(response!.headers()['x-sw-source']).toBeUndefined();
  await expect(page).toHaveTitle('Wiren Board Device Editor');
});

test('SW serves the cached page when the server answers 5xx', async ({
  page,
  context,
}) => {
  await loadAppWithSW(page, context);
  await assertControlled(page);

  server.setDocStatus(503);
  const response = await page.reload({ waitUntil: 'commit' });
  server.setDocStatus(0);

  expect(response).not.toBeNull();
  expect(response!.status()).toBe(200);
  expect(response!.headers()['x-sw-source']).toBe('cache');
  await expect(page).toHaveTitle('Wiren Board Device Editor');
});
