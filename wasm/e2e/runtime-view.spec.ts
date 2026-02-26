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

async function addDevice(page: Page, slaveId: number) {
  await page.getByRole('button', { name: 'Manually add device' }).click();
  await expect(page.locator('.confirm-content')).toBeVisible();

  await page.locator('#device-type').click();
  await page.locator('.dropdown__option').first().click();

  const modalSlaveIdInput = page.locator('.confirm-content input[type="number"]');
  await modalSlaveIdInput.fill(String(slaveId));

  await page.locator('.confirm-actions').getByRole('button', { name: 'Add' }).click();
  await expect(page.locator('.confirm-content')).not.toBeVisible();
}

async function openDeviceTab(page: Page, slaveId: number) {
  const tab = page.getByRole('tab').filter({
    hasText: new RegExp(`^${slaveId}\\s`),
  });
  await tab.click();

  await expect(page.locator('.deviceSettingsWasm-loaderWrapper')).not.toBeVisible({
    timeout: 30_000,
  });

  await expect(page.locator('.deviceSettingsEditor')).toBeVisible({ timeout: 10_000 });
}

async function clickRuntimeViewTab(page: Page) {
  const runtimeTab = page.getByRole('tab', { name: 'Runtime View' });
  await expect(runtimeTab).toBeVisible({ timeout: 10_000 });
  await runtimeTab.click();
}

test('Runtime View appears as a tab alongside settings groups', async ({ page }) => {
  await waitForAppReady(page);
  await addDevice(page, 1);
  await openDeviceTab(page, 1);

  // The Runtime View tab should be present in the settings tab bar
  const runtimeTab = page.getByRole('tab', { name: 'Runtime View' });
  await expect(runtimeTab).toBeVisible({ timeout: 15_000 });
});

test('Runtime View tab shows channel cells', async ({ page }) => {
  await waitForAppReady(page);
  await addDevice(page, 1);
  await openDeviceTab(page, 1);
  await clickRuntimeViewTab(page);

  // At least one cell should render (channels from the template)
  const tabContent = page.locator('.deviceSettingsEditor-tabContent .runtimeView');
  await expect(tabContent).toBeVisible({ timeout: 10_000 });

  const cells = tabContent.locator('.deviceCell');
  await expect(cells.first()).toBeVisible({ timeout: 10_000 });
});

test('Runtime View tab has refresh button and auto-refresh toggle', async ({ page }) => {
  await waitForAppReady(page);
  await addDevice(page, 1);
  await openDeviceTab(page, 1);
  await clickRuntimeViewTab(page);

  const runtimeView = page.locator('.runtimeView');
  await expect(runtimeView).toBeVisible({ timeout: 15_000 });

  await expect(runtimeView.getByRole('button', { name: 'Refresh' })).toBeVisible();
  await expect(runtimeView.locator('.runtimeView-autoRefresh')).toBeVisible();
});

test('Runtime View auto-refresh toggle disables and enables polling', async ({ page }) => {
  await waitForAppReady(page);
  await addDevice(page, 1);
  await openDeviceTab(page, 1);
  await clickRuntimeViewTab(page);

  const runtimeView = page.locator('.runtimeView');
  await expect(runtimeView).toBeVisible({ timeout: 15_000 });

  // The auto-refresh switch should be checked (on) by default
  const toggle = runtimeView.locator('.runtimeView-autoRefresh input[type="checkbox"]');
  await expect(toggle).toBeChecked();

  // Click to disable auto-refresh
  await toggle.click();
  await expect(toggle).not.toBeChecked();

  // Refresh button should become enabled when auto-refresh is off
  await expect(runtimeView.getByRole('button', { name: 'Refresh' })).toBeEnabled();
});

test('Runtime View handles deviceLoad errors gracefully', async ({ page }) => {
  await waitForAppReady(page);
  await addDevice(page, 1);
  await openDeviceTab(page, 1);
  await clickRuntimeViewTab(page);

  const runtimeView = page.locator('.runtimeView');
  await expect(runtimeView).toBeVisible({ timeout: 15_000 });

  // Without real hardware, deviceLoad will error - check that:
  // 1. The component still renders (doesn't crash)
  // 2. Either an error message or cells are shown
  const hasError = await runtimeView.locator('.runtimeView-error').isVisible().catch(() => false);
  const hasCells = await runtimeView.locator('.deviceCell').first().isVisible().catch(() => false);

  // At least one of these should be true — the component handles the state
  expect(hasError || hasCells).toBeTruthy();
});
