import path from 'path';
import { test, expect, type Page } from '@playwright/test';
import { BASE_URL } from './helpers';
import { TestServer } from './test-server';

const DIST_DIR = path.resolve(__dirname, '..', 'dist-configurator');

/**
 * The whole DALI page against the simulated WB-DALI module (slave id 250,
 * see wbdali_browser.browser.SIM_SLAVE_ID): the real daemon under Pyodide,
 * the real homeui page, an in-memory bus instead of a serial port. No
 * hardware, no WebSerial grant, no network.
 */

let server: TestServer;

test.beforeAll(async () => {
  server = new TestServer(DIST_DIR);
  await server.start();
});

test.afterAll(async () => {
  await server.stop().catch(() => {});
});

// Booting Pyodide and scanning the simulated bus takes a while in CI.
test.setTimeout(240_000);

async function openSimDali(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem('wb-dali-gateways', JSON.stringify([{
      id: 'wb-dali_250',
      slaveId: 250,
      deviceType: 'WB-DALI',
      serial: { baud_rate: 115200, data_bits: 8, parity: 'N', stop_bits: 2 },
    }]));
  });
  await page.goto(`${BASE_URL}/#dali`, { waitUntil: 'load' });
}

test('boots the daemon, scans the simulated bus and shows live controls', async ({ page }) => {
  await openSimDali(page);

  // The tree renders once the daemon answers GetList — no port gate on a
  // simulated gateway, no "failed to start".
  const tree = page.locator('.tree-itemButton');
  await expect(tree.filter({ hasText: 'Bus 1' })).toBeVisible({ timeout: 180_000 });
  await expect(page.getByText('The DALI service failed to start.')).toHaveCount(0);

  // A fresh installation is scanned unprompted; the simulated bus 1 carries
  // four luminaires and a wall switch, so device rows appear under it.
  await expect
    .poll(async () => tree.count(), { timeout: 180_000, message: 'auto-scan populates the tree' })
    .toBeGreaterThan(5);

  // The bus tab carries the broadcast strip.
  await tree.filter({ hasText: 'Bus 1' }).first().click();
  const strip = page.locator('.daliDeviceControls-strip');
  await expect(strip).toBeVisible({ timeout: 60_000 });
  await expect(strip).toContainText('Wanted Level');
  await expect(strip.getByRole('button', { name: 'Off' })).toBeVisible();

  // The syslog toggle is a controller affordance and must not be offered here.
  await expect(page.getByText('Save to syslog')).toHaveCount(0);

  // The bus monitor docks into the console panel from the header button. With
  // no bus monitored yet the panel explains itself instead of sitting empty,
  // and offers to enable monitoring right there.
  const monitorButton = page.getByRole('button', { name: 'Bus Monitor' });
  await monitorButton.click();
  await expect(page.locator('.daliWasm .consolePanel, [class*="consolePanel"]').first())
    .toBeVisible({ timeout: 10_000 });
  const emptyState = page.locator('.daliMonitorEmpty');
  await expect(emptyState).toBeVisible({ timeout: 10_000 });
  await emptyState.getByRole('button', { name: /Bus 1/ }).click();
  // Enabling registers the bus's monitor tab and the placeholder yields to it.
  await expect(emptyState).toHaveCount(0, { timeout: 30_000 });
});

test('opens a commissioned luminaire and shows its settings form', async ({ page }) => {
  await openSimDali(page);

  const tree = page.locator('.tree-itemButton');
  await expect(tree.filter({ hasText: 'Bus 1' })).toBeVisible({ timeout: 180_000 });
  await expect
    .poll(async () => tree.count(), { timeout: 180_000, message: 'auto-scan populates the tree' })
    .toBeGreaterThan(5);

  await tree.filter({ hasText: 'Bus 1' }).first().click();
  await expect(page.locator('.daliDeviceControls-strip')).toBeVisible({ timeout: 60_000 });

  // Any device row under bus 1 will do: the first one the scan produced.
  await tree.nth(2).click();
  await expect(page.locator('.wb-jsonEditor-objectProperty').first())
    .toBeVisible({ timeout: 120_000 });
});
