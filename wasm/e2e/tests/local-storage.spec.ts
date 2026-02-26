import { test, expect } from '../fixtures/base';
import { map3et } from '../data/device-types';

/** Scan devices and wait for the first device tab + settings to load */
async function scanAndSelectDevice(appPage) {
  await appPage.getByRole('button', { name: 'Select port' }).click();
  await appPage.getByRole('button', { name: 'Scan' }).click();

  // Use device tabs in the sidebar, not group tabs inside the editor
  const tab = appPage.locator('.deviceSettingsWasm-aside').getByRole('tab').first();
  await expect(tab).toBeVisible({ timeout: 30_000 });
  await tab.click();

  const content = appPage.locator('.deviceSettingsWasm-content');
  await expect(content).toBeVisible({ timeout: 10_000 });
  await appPage.locator('.deviceSettingsEditor-parameter').first().waitFor({ timeout: 10_000 });
}

test.describe('Local storage persistence', () => {
  test('Save local stores device in localStorage', async ({ appPage }) => {
    await scanAndSelectDevice(appPage);

    // Click "Save local"
    await appPage.getByRole('button', { name: 'Save local' }).click();

    // Verify localStorage has the device
    const stored = await appPage.evaluate(() => {
      return JSON.parse(localStorage.getItem('devices') || '[]');
    });

    expect(stored).toHaveLength(1);
    expect(stored[0].cfg.slave_id).toBe(1);
    expect(stored[0].device_signature).toBe(map3et.device_type);
  });

  test('saved device persists after reload', async ({ appPage }) => {
    await scanAndSelectDevice(appPage);

    // Save to localStorage
    await appPage.getByRole('button', { name: 'Save local' }).click();

    // Reload the page — the mocks are re-injected via context.addInitScript
    await appPage.reload();

    // Wait for the app to reinitialize
    await appPage.waitForFunction(
      () => (window as any).Module?.serial !== undefined,
      undefined,
      { timeout: 10_000 },
    );
    await appPage.locator('.page-actions').waitFor({ state: 'visible', timeout: 10_000 });

    // The device tab should still be visible (from localStorage, no scan needed)
    const deviceTabs = appPage.locator('.deviceSettingsWasm-aside').getByRole('tab');
    await expect(deviceTabs.first()).toBeVisible({ timeout: 10_000 });
    await expect(deviceTabs.first()).toContainText(`1`);
  });

  test('Remove local removes device tab', async ({ appPage }) => {
    await scanAndSelectDevice(appPage);

    // Save, then verify "Remove local" appears
    await appPage.getByRole('button', { name: 'Save local' }).click();

    // After saving, the button should change to "Remove local"
    const removeBtn = appPage.getByRole('button', { name: 'Remove local' });
    await expect(removeBtn).toBeVisible({ timeout: 5_000 });

    // Click Remove local
    await removeBtn.click();

    // Verify localStorage is cleared
    const stored = await appPage.evaluate(() => {
      return JSON.parse(localStorage.getItem('devices') || '[]');
    });
    expect(stored).toHaveLength(0);

    // The "Save local" button should be back
    await expect(appPage.getByRole('button', { name: 'Save local' })).toBeVisible({ timeout: 5_000 });
  });

  test('scanned and local devices coexist as separate tabs', async ({ appPage }) => {
    // Pre-seed localStorage with a manual device (different slave_id)
    await appPage.evaluate((deviceType) => {
      const manualDevice = {
        device_signature: deviceType,
        cfg: {
          slave_id: 5,
          baud_rate: 9600,
          data_bits: 8,
          parity: 'N',
          stop_bits: 2,
        },
      };
      localStorage.setItem('devices', JSON.stringify([manualDevice]));
      // Dispatch storage event so the app picks it up
      window.dispatchEvent(new StorageEvent('storage', { key: 'devices' }));
    }, map3et.device_type);

    // Wait for the manual device tab to appear (use sidebar device tabs only)
    const deviceTabs = appPage.locator('.deviceSettingsWasm-aside').getByRole('tab');
    await expect(deviceTabs.filter({ hasText: '5' })).toBeVisible({ timeout: 10_000 });

    // Now scan — should find slave_id=1
    await appPage.getByRole('button', { name: 'Select port' }).click();
    await appPage.getByRole('button', { name: 'Scan' }).click();

    // Wait for scan results
    await expect(deviceTabs.filter({ hasText: '1' })).toBeVisible({ timeout: 30_000 });

    // Both device tabs should be visible in the sidebar
    await expect(deviceTabs).toHaveCount(2);
  });
});
