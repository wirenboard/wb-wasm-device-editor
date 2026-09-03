import fs from 'fs';
import path from 'path';
import { test, expect, type Page } from '@playwright/test';

/**
 * The offline build is one self-contained dist-offline/index.html meant to be
 * opened straight from disk. These tests prove exactly that: no server, and
 * every http(s) request aborted so a regression that reintroduces a remote
 * fetch fails loudly instead of quietly depending on the network.
 */

const OFFLINE_INDEX = path.resolve(__dirname, '..', 'dist-offline', 'index.html');
const OFFLINE_URL = `file://${OFFLINE_INDEX}`;

test.skip(!fs.existsSync(OFFLINE_INDEX), 'dist-offline/index.html is not built (npm run build:offline)');

// Decompressing the embedded assets takes a while on a loaded CI node.
test.setTimeout(300_000);

async function blockNetwork(page: Page) {
  await page.route(/^https?:\/\//, (route) => route.abort());
}

test('boots the editor from file:// with networking blocked', async ({ page }) => {
  await blockNetwork(page);
  await page.goto(OFFLINE_URL);
  await expect(page).toHaveTitle('Wiren Board Device Editor');
  await expect(page.getByRole('button', { name: 'Add device' })).toBeVisible({ timeout: 120_000 });
});

test('boots the DALI page against the simulated bus from file://', async ({ page }) => {
  await blockNetwork(page);
  await page.addInitScript(() => {
    window.localStorage.setItem('wb-dali-gateways', JSON.stringify([{
      id: 'wb-dali_250',
      slaveId: 250,
      deviceType: 'WB-DALI',
      serial: { baud_rate: 115200, data_bits: 8, parity: 'N', stop_bits: 2 },
    }]));
  });
  await page.goto(`${OFFLINE_URL}#dali`);

  // The daemon answers GetList once Pyodide has come up from the embedded
  // bundle — through the inline worker, since file:// cannot load worker
  // scripts by URL.
  const tree = page.locator('.tree-itemButton');
  await expect(tree.filter({ hasText: 'Bus 1' })).toBeVisible({ timeout: 240_000 });
  await expect(page.getByText('The DALI service failed to start.')).toHaveCount(0);
});
