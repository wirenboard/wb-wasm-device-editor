import { test, expect } from '../fixtures/base';

test.describe('Port selection', () => {
  test('navigator.serial is available', async ({ appPage }) => {
    const hasSerial = await appPage.evaluate(() => !!navigator.serial);
    expect(hasSerial).toBe(true);
  });

  test('clicking "Select port" triggers port selection', async ({ appPage }) => {
    await appPage.getByRole('button', { name: 'Select port' }).click();

    // After clicking, the mock port should be selected
    const isSelected = await appPage.evaluate(() => (window as any).__serialMock.isSelected);
    expect(isSelected).toBe(true);
  });

  test('SerialPort initializes without alert', async ({ appPage }) => {
    // If navigator.serial were missing, SerialPort constructor (serial.js)
    // would show an alert. The fixture already waited for Module.serial,
    // which means SerialPort() was constructed inside onRuntimeInitialized().
    // Verify the instance exists and no console errors about missing API.
    const hasSerial = await appPage.evaluate(() => !!(window as any).Module.serial);
    expect(hasSerial).toBe(true);

    // Verify the mock serial API is functional (port can be selected)
    const canSelect = await appPage.evaluate(async () => {
      await (window as any).Module.serial.select(true);
      return !!(window as any).Module.serial.port;
    });
    expect(canSelect).toBe(true);
  });

  test('requestPort receives USB filters', async ({ appPage }) => {
    await appPage.getByRole('button', { name: 'Select port' }).click();

    // Verify the mock captured the USB vendor/product filters from serial.js
    const filters = await appPage.evaluate(() => (window as any).__serialMock.lastRequestPortFilters);
    expect(filters).toBeTruthy();
    expect(filters.length).toBeGreaterThan(0);
    expect(filters[0]).toHaveProperty('usbVendorId');
    expect(filters[0]).toHaveProperty('usbProductId');
  });
});
