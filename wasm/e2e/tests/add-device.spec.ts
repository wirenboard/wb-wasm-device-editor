import { test, expect } from '../fixtures/base';
import { map3et } from '../data/device-types';

test.describe('Manually add device', () => {
  test('clicking "Manually add device" opens modal', async ({ appPage }) => {
    await appPage.getByRole('button', { name: 'Manually add device' }).click();

    // Modal dialog should appear
    const dialog = appPage.locator('.dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Modal title should indicate adding a device
    const title = dialog.locator('.dialog-title');
    await expect(title).toBeVisible();
  });

  test('adding a device creates a tab and loads config', async ({ appPage }) => {
    await appPage.getByRole('button', { name: 'Manually add device' }).click();

    const dialog = appPage.locator('.dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Select device type from the dropdown
    const deviceTypeInput = dialog.locator('input[id="device-type"]');
    await deviceTypeInput.click();
    await appPage.locator('.dropdown__option').filter({ hasText: map3et.device.name }).click();

    // Set slave_id to 5
    const slaveIdInput = dialog.locator('input[type="number"]');
    await slaveIdInput.fill('5');

    // Click "Add"
    await dialog.getByRole('button', { name: 'Add' }).click();

    // Modal should close
    await expect(dialog).not.toBeVisible({ timeout: 5_000 });

    // A new tab should appear
    const tab = appPage.locator('role=tab').filter({ hasText: '5' });
    await expect(tab).toBeVisible({ timeout: 10_000 });

    // Click the tab — config should load
    await tab.click();
    const content = appPage.locator('.deviceSettingsWasm-content');
    await expect(content).toBeVisible({ timeout: 10_000 });

    // Device settings editor should render parameters
    await appPage.locator('.deviceSettingsEditor-parameter').first().waitFor({ timeout: 10_000 });
  });

  test('added device shows in localStorage', async ({ appPage }) => {
    await appPage.getByRole('button', { name: 'Manually add device' }).click();

    const dialog = appPage.locator('.dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Select device type
    const deviceTypeInput = dialog.locator('input[id="device-type"]');
    await deviceTypeInput.click();
    await appPage.locator('.dropdown__option').filter({ hasText: map3et.device.name }).click();

    // Set slave_id
    const slaveIdInput = dialog.locator('input[type="number"]');
    await slaveIdInput.fill('10');

    // Click "Add"
    await dialog.getByRole('button', { name: 'Add' }).click();

    // Verify device is stored in localStorage
    const stored = await appPage.evaluate(() => {
      return JSON.parse(localStorage.getItem('devices') || '[]');
    });

    expect(stored).toHaveLength(1);
    // slave_id from number input is stored as string by the form
    expect(Number(stored[0].cfg.slave_id)).toBe(10);
    expect(stored[0].device_signature).toBe(map3et.device_type);
  });

  test('deviceLoadConfig error shows alert', async ({ appPage }) => {
    // Enable error injection before adding a device
    await appPage.evaluate(() => {
      (window as any).__mockError = true;
    });

    await appPage.getByRole('button', { name: 'Manually add device' }).click();

    const dialog = appPage.locator('.dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Select device type
    const deviceTypeInput = dialog.locator('input[id="device-type"]');
    await deviceTypeInput.click();
    await appPage.locator('.dropdown__option').filter({ hasText: map3et.device.name }).click();

    // Set slave_id
    const slaveIdInput = dialog.locator('input[type="number"]');
    await slaveIdInput.fill('3');

    // Click "Add"
    await dialog.getByRole('button', { name: 'Add' }).click();
    await expect(dialog).not.toBeVisible({ timeout: 5_000 });

    // Click the new tab to trigger config loading
    const tab = appPage.locator('role=tab').filter({ hasText: '3' });
    await expect(tab).toBeVisible({ timeout: 10_000 });
    await tab.click();

    // Alert should appear with error
    const alert = appPage.locator('.deviceSettingsWasm-alert');
    await expect(alert).toBeVisible({ timeout: 10_000 });
  });
});
