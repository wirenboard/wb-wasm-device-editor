import path from 'path';
import { test, expect, type Page } from '@playwright/test';
import { BASE_URL } from './helpers';
import { TestServer } from './test-server';

const DIST_DIR = path.resolve(__dirname, '..', 'dist-configurator');

let server: TestServer;

// Share a single server instance across all tests to avoid port release timing issues
test.beforeAll(async () => {
  server = new TestServer(DIST_DIR);
  await server.start();
});

test.afterAll(async () => {
  await server.stop().catch(() => {});
});

/**
 * Wait for the app to fully initialize (WASM module loaded, device types ready).
 */
async function waitForAppReady(page: Page) {
  await page.goto(BASE_URL, { waitUntil: 'load' });
  await expect(page).toHaveTitle('Wiren Board Device Editor');
  // The "Add device" button appears after configDeviceTypesStore is set.
  // WASM module initialization may intermittently stall — retry with a reload.
  const addDeviceButton = page.getByRole('button', { name: 'Add device' });
  try {
    await expect(addDeviceButton).toBeVisible({ timeout: 20_000 });
  } catch {
    await page.reload({ waitUntil: 'load' });
    await expect(addDeviceButton).toBeVisible({ timeout: 30_000 });
  }
}

/**
 * Add a device via the "Add device" modal.
 */
async function addDevice(page: Page, slaveId: number) {
  await page.getByRole('button', { name: 'Add device' }).click();
  await expect(page.locator('.confirm-content')).toBeVisible();

  // Select first available device type (react-select with isSearchable)
  // The device-type select arrives preselected, and react-select's
  // single-value overlay sits over the input, so a hit-tested click on
  // #device-type never lands. Open the menu from the keyboard instead.
  await page.locator('#device-type').focus();
  await page.keyboard.press('ArrowDown');
  await page.locator('.dropdown__option').first().click();

  // Set slave_id in the modal's number input
  const modalSlaveIdInput = page.locator('.confirm-content input[type="number"]');
  await modalSlaveIdInput.fill(String(slaveId));

  // Click "Add" in the modal actions
  await page.locator('.confirm-actions').getByRole('button', { name: 'Add' }).click();
  await expect(page.locator('.confirm-content')).not.toBeVisible();
}

/**
 * Click a device tab in the sidebar and wait for the settings form to render.
 * Note: loadConfig may fail without hardware — the error alert is expected, the form still renders.
 */
async function openDeviceTab(page: Page, slaveId: number) {
  const tab = page.getByRole('tab').filter({
    hasText: new RegExp(`^${slaveId}\\s`),
  });
  await tab.click();

  // Wait for config loading to finish
  await expect(page.locator('.deviceSettingsWasm-loaderWrapper')).not.toBeVisible({
    timeout: 30_000,
  });

  // Settings editor should appear even if loadConfig errored
  await expect(page.locator('.deviceSettingsEditor')).toBeVisible({ timeout: 10_000 });
}

/**
 * Get the slave_id input inside the rendered settings form.
 * The placeholder text comes from the device type schema delivered by the WASM module.
 */
function getSlaveIdInput(page: Page) {
  return page.getByPlaceholder('decimal (e.g. 123) or hex (e.g. 0xAF)');
}

test('out-of-range slave_id shows inline error and disables Save', async ({ page }) => {
  await waitForAppReady(page);
  await addDevice(page, 1);
  await openDeviceTab(page, 1);

  await getSlaveIdInput(page).fill('900');

  await expect(page.locator('.wb-jsonEditor-errorText')).toContainText(
    'Slave ID must be an integer between 1 and 247',
  );
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
});

test('zero slave_id shows inline error', async ({ page }) => {
  await waitForAppReady(page);
  await addDevice(page, 1);
  await openDeviceTab(page, 1);

  await getSlaveIdInput(page).fill('0');

  await expect(page.locator('.wb-jsonEditor-errorText')).toContainText(
    'Slave ID must be an integer between 1 and 247',
  );
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
});

test('boundary: 247 is valid, 248 is invalid', async ({ page }) => {
  await waitForAppReady(page);
  await addDevice(page, 1);
  await openDeviceTab(page, 1);

  const input = getSlaveIdInput(page);

  // First set an invalid value to establish error state
  await input.fill('248');
  await expect(page.locator('.wb-jsonEditor-errorText')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();

  // 247 should clear the error and enable Save
  await input.fill('247');
  await expect(page.locator('.wb-jsonEditor-errorText')).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled();
});

test('duplicate slave_id shows duplicate error and disables Save', async ({ page }) => {
  await waitForAppReady(page);
  await addDevice(page, 1);
  await addDevice(page, 2);
  await openDeviceTab(page, 1);

  await getSlaveIdInput(page).fill('2');

  await expect(page.getByText('Duplicate slave id')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
});

test('error clears when value is corrected', async ({ page }) => {
  await waitForAppReady(page);
  await addDevice(page, 1);
  await openDeviceTab(page, 1);

  const input = getSlaveIdInput(page);

  // Invalid value shows error and disables Save
  await input.fill('900');
  await expect(page.locator('.wb-jsonEditor-errorText')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();

  // Corrected value clears error and enables Save
  await input.fill('100');
  await expect(page.locator('.wb-jsonEditor-errorText')).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled();
});
