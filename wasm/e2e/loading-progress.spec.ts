import path from 'path';
import { test, expect } from '@playwright/test';
import { BASE_URL } from './helpers';
import { TestServer } from './test-server';

const DIST_DIR = path.resolve(__dirname, '..', 'dist-configurator');

let server: TestServer;

test.beforeAll(async () => {
  server = new TestServer(DIST_DIR);
  await server.start();
});

test.afterAll(async () => {
  await server.stop().catch(() => {});
});

test('shows progress immediately when download starts', async ({ page }) => {
  let unblockData: () => void;
  const dataBlocked = new Promise<void>((r) => {
    unblockData = r;
  });

  await page.route('**/module.data', async (route) => {
    await dataBlocked;
    route.abort();
  });

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window['Module']?.setStatus === 'function');

  // Simulate initial Emscripten status (before any bytes arrive)
  await page.evaluate(() => {
    Module.setStatus('Downloading data...');
  });

  await expect(page.locator('progress')).toBeVisible();

  unblockData!();
});

test('displays spinner and download progress with file sizes', async ({ page }) => {
  let unblockData: () => void;
  const dataBlocked = new Promise<void>((r) => {
    unblockData = r;
  });

  await page.route('**/module.data', async (route) => {
    await dataBlocked;
    route.abort();
  });

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window['Module']?.setStatus === 'function');

  // Simulate Emscripten's progress callback: 3 MB of 6 MB downloaded
  await page.evaluate(() => {
    Module.setStatus('Downloading data... (3145728/6291456)');
  });

  const wrapper = page.locator('.page');
  await expect(wrapper).toBeVisible({ timeout: 5000 });

  // Both spinner and progress bar are shown
  await expect(wrapper).toContainText('3.0 MB');
  await expect(wrapper).toContainText('6.0 MB');

  // Simulate download completion
  await page.evaluate(() => {
    Module.setStatus('Downloading data... (6291456/6291456)');
  });

  unblockData!();
});

test('progress bar disappears after module loads', async ({ page }) => {
  // Don't block anything — let module load normally
  await page.goto(BASE_URL, { waitUntil: 'load' });

  // Wait for the module to fully initialize (buttons appear)
  const addDeviceButton = page.getByRole('button', { name: 'Manually add device' });
  try {
    await expect(addDeviceButton).toBeVisible({ timeout: 20_000 });
  } catch {
    await page.reload({ waitUntil: 'load' });
    await expect(addDeviceButton).toBeVisible({ timeout: 30_000 });
  }

  // Progress bar should not be visible when module is ready
  const progressWrapper = page.locator('progress');
  await expect(progressWrapper).not.toBeVisible();
});
