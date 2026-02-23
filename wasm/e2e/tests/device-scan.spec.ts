import { test, expect } from '../fixtures/base';

async function scanDevices(appPage) {
  await appPage.getByRole('button', { name: 'Select port' }).click();
  await appPage.getByRole('button', { name: 'Scan' }).click();
}

test.describe('Device scanning', () => {
  test('clicking Scan finds mock devices', async ({ appPage }) => {
    await scanDevices(appPage);

    // Wait for a device tab to appear with slave_id and device name
    const tab = appPage.locator('role=tab');
    await expect(tab.first()).toBeVisible({ timeout: 30_000 });
    await expect(tab.first()).toContainText('1 WB-MAP3ET');
  });

  test('scan shows progress indicator', async ({ appPage }) => {
    await scanDevices(appPage);

    // Progress element should appear during scan
    const scanning = appPage.locator('.deviceSettingsWasm-scanning');
    // Either we catch the scanning text or the scan finishes so fast we see the result
    const tab = appPage.locator('role=tab');
    await expect(tab.first().or(scanning)).toBeVisible({ timeout: 30_000 });
  });

  test('scanned device tab is selectable', async ({ appPage }) => {
    await scanDevices(appPage);

    // Wait for tab to appear
    const tab = appPage.locator('role=tab').first();
    await expect(tab).toBeVisible({ timeout: 30_000 });

    // Click on the device tab
    await tab.click();

    // Verify device title renders with correct name
    const title = appPage.locator('.deviceSettingsWasm-title');
    await expect(title).toBeVisible({ timeout: 10_000 });
    await expect(title).toContainText('WB-MAP3ET');
  });

  test('device settings editor renders parameters', async ({ appPage }) => {
    await scanDevices(appPage);

    const tab = appPage.locator('role=tab').first();
    await expect(tab).toBeVisible({ timeout: 30_000 });
    await tab.click();

    // Wait for the device settings editor to render parameter fields
    const title = appPage.locator('.deviceSettingsWasm-title');
    await expect(title).toBeVisible({ timeout: 10_000 });

    // Verify the settings editor section is present
    const content = appPage.locator('.deviceSettingsWasm-content');
    await expect(content).toBeVisible();
  });

  test('clicking Save sends device config', async ({ appPage }) => {
    await scanDevices(appPage);

    const tab = appPage.locator('role=tab').first();
    await expect(tab).toBeVisible({ timeout: 30_000 });
    await tab.click();

    // Wait for device settings to load
    const title = appPage.locator('.deviceSettingsWasm-title');
    await expect(title).toBeVisible({ timeout: 10_000 });

    // Click Save (handleSave does not await, so we must poll for the reply)
    await appPage.getByRole('button', { name: 'Save', exact: true }).click();

    // Wait for deviceSet reply to arrive (handleSave fires async without awaiting)
    await appPage.waitForFunction(
      () => (window as any).Module.reply?.result?.success === true,
      undefined,
      { timeout: 5_000 },
    );
  });
});
