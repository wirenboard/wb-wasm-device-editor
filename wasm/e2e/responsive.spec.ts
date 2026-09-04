import path from 'path';
import { test, expect, type Page } from '@playwright/test';
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

test.use({ viewport: { width: 375, height: 812 } });

async function waitForAppReady(page: Page) {
  await page.goto(BASE_URL, { waitUntil: 'load' });
  await expect(page).toHaveTitle('Wiren Board Device Editor');
  const addDeviceButton = page.getByRole('button', { name: 'Add device' });
  try {
    await expect(addDeviceButton).toBeVisible({ timeout: 20_000 });
  } catch {
    await page.reload({ waitUntil: 'load' });
    await expect(addDeviceButton).toBeVisible({ timeout: 30_000 });
  }
}

test('header action buttons are visible and not overflowing on mobile', async ({ page }) => {
  await waitForAppReady(page);

  const scanButton = page.getByRole('button', { name: 'Scan' });
  const saveButton = page.getByRole('button', { name: 'Save' });

  await expect(scanButton).toBeVisible();
  await expect(saveButton).toBeVisible();

  // Verify buttons are within viewport
  const scanBox = await scanButton.boundingBox();
  const saveBox = await saveButton.boundingBox();
  expect(scanBox.x + scanBox.width).toBeLessThanOrEqual(375);
  expect(saveBox.x + saveBox.width).toBeLessThanOrEqual(375);
});

test('sidebar stacks above content in column layout on mobile', async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem('devices'));
  await waitForAppReady(page);

  // Add a device so the sidebar has content
  await page.getByRole('button', { name: 'Add device' }).click();
  await expect(page.locator('.confirm-content')).toBeVisible();

  await page.locator('.dropdown__control:has(#device-type)').click();
  await page.locator('.dropdown__option').first().click();

  const modalSlaveIdInput = page.locator('.confirm-content input[type="number"]');
  await modalSlaveIdInput.fill('1');

  await page.locator('.confirm-actions').getByRole('button', { name: 'Add' }).click();
  await expect(page.locator('.confirm-content')).not.toBeVisible();

  // Wait for device settings to load
  await expect(page.locator('.deviceSettingsWasm-loaderWrapper')).not.toBeVisible({
    timeout: 30_000,
  });

  const aside = page.locator('.deviceSettingsWasm-aside');
  const content = page.locator('.deviceSettingsWasm-content');

  const asideBox = await aside.boundingBox();
  const contentBox = await content.boundingBox();

  // In column layout, aside should be above content (lower Y value)
  expect(asideBox.y).toBeLessThan(contentBox.y);
  // Both should span full width (not side-by-side)
  expect(asideBox.width).toBeGreaterThan(300);
  expect(contentBox.width).toBeGreaterThan(300);
});
