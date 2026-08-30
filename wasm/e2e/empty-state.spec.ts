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
  // Wait for module initialization by checking if the loader disappears and buttons become active
  await expect(page.locator('.page-loader')).not.toBeVisible({ timeout: 60_000 });
  const addDeviceButton = page.getByRole('button', { name: 'Add device' });
  await expect(addDeviceButton).toBeVisible({ timeout: 10_000 });
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
  await page.getByRole('button', { name: 'Add device' }).click();
  await expect(page.locator('.confirm-content')).toBeVisible();

  // The device-type select arrives preselected, and react-select's
  // single-value overlay sits over the input, so a hit-tested click on
  // #device-type never lands. Open the menu from the keyboard instead.
  await page.locator('#device-type').focus();
  await page.keyboard.press('ArrowDown');
  // Wait for dropdown options to appear
  await expect(page.locator('.dropdown__option').first()).toBeVisible();
  await page.locator('.dropdown__option').first().click();

  const modalSlaveIdInput = page.locator('.confirm-content input[type="number"]');
  await modalSlaveIdInput.fill('1');

  await page.locator('.confirm-actions').getByRole('button', { name: 'Add' }).click();
  await expect(page.locator('.confirm-content')).not.toBeVisible();

  // Empty state should be gone
  await expect(page.locator('.deviceSettingsWasm-emptyState')).not.toBeVisible();
});
