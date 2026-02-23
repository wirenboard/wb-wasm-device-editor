import { test, expect } from '../fixtures/base';

test.describe('Module initialization', () => {
  test('Module.isReady resolves', async ({ appPage }) => {
    const isReady = await appPage.evaluate(() => {
      return (window as any).Module.isReady.then(() => true);
    });
    expect(isReady).toBe(true);
  });

  test('Module.serial exists', async ({ appPage }) => {
    const hasSerial = await appPage.evaluate(() => {
      return !!(window as any).Module.serial;
    });
    expect(hasSerial).toBe(true);
  });

  test('app exits loading state', async ({ appPage }) => {
    // Fixture already waits for .page-actions, so loading is done
    await expect(appPage.locator('.page-title')).toHaveText('Wiren Board Device Editor');
  });

  test('action buttons visible', async ({ appPage }) => {
    // Fixture already waits for .page-actions visibility
    const actions = appPage.locator('.page-actions');
    await expect(actions.getByRole('button', { name: 'Scan' })).toBeVisible();
    await expect(actions.getByRole('button', { name: 'Select port' })).toBeVisible();
    await expect(actions.getByRole('button', { name: 'Save' })).toBeVisible();
    await expect(actions.getByRole('button', { name: 'Manually add device' })).toBeVisible();
  });
});
