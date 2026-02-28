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

async function waitForAppReady(page: Page) {
  await page.goto(BASE_URL, { waitUntil: 'load' });
  await expect(page).toHaveTitle('Wiren Board Device Editor');
  const addDeviceButton = page.getByRole('button', { name: 'Manually add device' });
  try {
    await expect(addDeviceButton).toBeVisible({ timeout: 20_000 });
  } catch {
    await page.reload({ waitUntil: 'load' });
    await expect(addDeviceButton).toBeVisible({ timeout: 30_000 });
  }
}

test('empty state is visible on fresh load', async ({ page }) => {
  // Clear any saved devices
  await page.addInitScript(() => localStorage.removeItem('devices'));
  await waitForAppReady(page);

  const emptyState = page.locator('.deviceSettingsWasm-emptyState');
  await expect(emptyState).toBeVisible();
  await expect(emptyState).toContainText('No devices found');
});

test('empty state disappears after adding a device manually', async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem('devices'));
  await waitForAppReady(page);

  await expect(page.locator('.deviceSettingsWasm-emptyState')).toBeVisible();

  // Add a device via the modal
  await page.getByRole('button', { name: 'Manually add device' }).click();
  await expect(page.locator('.confirm-content')).toBeVisible();

  await page.locator('#device-type').click();
  await page.locator('.dropdown__option').first().click();

  const modalSlaveIdInput = page.locator('.confirm-content input[type="number"]');
  await modalSlaveIdInput.fill('1');

  await page.locator('.confirm-actions').getByRole('button', { name: 'Add' }).click();
  await expect(page.locator('.confirm-content')).not.toBeVisible();

  // Empty state should be gone
  await expect(page.locator('.deviceSettingsWasm-emptyState')).not.toBeVisible();
});
