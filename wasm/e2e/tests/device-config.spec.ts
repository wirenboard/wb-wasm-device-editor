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

  // Wait for settings editor to fully render
  const content = appPage.locator('.deviceSettingsWasm-content');
  await expect(content).toBeVisible({ timeout: 10_000 });
  await appPage.locator('.deviceSettingsEditor-parameter').first().waitFor({ timeout: 10_000 });
}

/** Switch to "General" group tab where baud_rate lives */
async function switchToGeneralGroup(appPage) {
  const generalTab = appPage.locator('.deviceSettingsEditor-tabs').getByRole('tab').filter({ hasText: 'General' });
  await generalTab.click();
  // Wait for General group params to render
  const baudRateRow = appPage.locator('.deviceSettingsEditor-parameter').filter({ hasText: 'Baud rate' });
  await expect(baudRateRow).toBeVisible({ timeout: 5_000 });
}

test.describe('Device configuration editing', () => {
  test('baud_rate parameter displays loaded value', async ({ appPage }) => {
    await scanAndSelectDevice(appPage);
    await switchToGeneralGroup(appPage);

    // Find the baud_rate parameter row
    const paramRow = appPage
      .locator('.deviceSettingsEditor-parameter')
      .filter({ hasText: 'Baud rate' });

    // The dropdown should show the enum_title for the default register value (96 → "9600")
    const selectedValue = paramRow.locator('.dropdown__single-value');
    await expect(selectedValue).toHaveText('9600');
  });

  test('editing baud_rate and saving sends updated value', async ({ appPage }) => {
    await scanAndSelectDevice(appPage);
    await switchToGeneralGroup(appPage);

    // Open the baud_rate dropdown
    const paramRow = appPage
      .locator('.deviceSettingsEditor-parameter')
      .filter({ hasText: 'Baud rate' });
    await paramRow.locator('.dropdown__control').click();

    // Select 19200 (register value 192)
    await appPage.locator('.dropdown__option').filter({ hasText: '19200' }).click();

    // Verify the dropdown now shows 19200
    const selectedValue = paramRow.locator('.dropdown__single-value');
    await expect(selectedValue).toHaveText('19200');

    // Click Save
    await appPage.getByRole('button', { name: 'Save', exact: true }).click();

    // Wait for deviceSet to be called and inspect the payload
    const payload = await appPage.evaluate(async () => {
      for (let i = 0; i < 50; i++) {
        if ((window as any).__lastDeviceSetPayload) {
          return (window as any).__lastDeviceSetPayload;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return null;
    });

    expect(payload).not.toBeNull();
    // editedData only includes parameters that differ from the schema default.
    // Changing baud_rate from 96 (default) to 192 makes it dirty, so it's included.
    expect(payload.parameters.baud_rate).toBe(192);
  });

  test('Save sends correct device_type and cfg fields', async ({ appPage }) => {
    await scanAndSelectDevice(appPage);

    // Click Save without editing anything
    await appPage.getByRole('button', { name: 'Save', exact: true }).click();

    const payload = await appPage.evaluate(async () => {
      for (let i = 0; i < 50; i++) {
        if ((window as any).__lastDeviceSetPayload) {
          return (window as any).__lastDeviceSetPayload;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return null;
    });

    expect(payload).not.toBeNull();
    expect(payload.device_type).toBe(map3et.device_type);
    // Connection cfg fields should be preserved from the scanned device
    expect(payload.slave_id).toBe(1);
    expect(payload.baud_rate).toBe(9600);
    expect(payload.parity).toBe('N');
    // parameters is empty when nothing was edited (all values match schema defaults)
    expect(payload.parameters).toBeDefined();
  });
});
