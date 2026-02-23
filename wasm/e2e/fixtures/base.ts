import { test as base, type Page } from '@playwright/test';
import { getWebSerialMockScript } from '../mocks/webserial-mock';
import { getModuleMockScript } from '../mocks/module-mock';

export type AppFixtures = {
  appPage: Page;
};

export const test = base.extend<AppFixtures>({
  appPage: async ({ context, page }, use) => {
    // Use context-level init scripts so they persist across any page navigations/reloads
    await context.addInitScript(getWebSerialMockScript());
    await context.addInitScript(getModuleMockScript());

    // Navigate to the app
    await page.goto('/');

    // Wait for Module.serial to exist (mock initialization complete)
    // If the first attempt times out (e.g. due to Vite HMR reload), retry once
    try {
      await page.waitForFunction(
        () => (window as any).Module?.serial !== undefined,
        undefined,
        { timeout: 10_000 },
      );
    } catch {
      await page.reload();
      await page.waitForFunction(
        () => (window as any).Module?.serial !== undefined,
        undefined,
        { timeout: 10_000 },
      );
    }

    // Wait for the app to finish loading (configDeviceTypesStore populated)
    // so action buttons are visible and the app is interactive
    await page.locator('.page-actions').waitFor({ state: 'visible', timeout: 10_000 });

    await use(page);
  },
});

export { expect } from '@playwright/test';
