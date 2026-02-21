import fs from 'fs';
import type { BrowserContext, Page } from '@playwright/test';

export const PORT = 3210;
export const BASE_URL = `http://localhost:${PORT}`;

/**
 * Wait for the service worker to activate and claim the page.
 */
export async function waitForSWActivated(
  page: Page,
  context: BrowserContext,
): Promise<void> {
  // Wait for the SW to appear in the browser context
  if (context.serviceWorkers().length === 0) {
    await context.waitForEvent('serviceworker');
  }

  // Wait for the SW to control the page (after activate + clients.claim())
  await page.evaluate(() => {
    return new Promise<void>((resolve) => {
      if (navigator.serviceWorker.controller) {
        resolve();
        return;
      }
      navigator.serviceWorker.addEventListener(
        'controllerchange',
        () => resolve(),
        { once: true },
      );
    });
  });
}

/**
 * Navigate to the app and wait for the SW to fully activate.
 */
export async function loadAppWithSW(
  page: Page,
  context: BrowserContext,
): Promise<void> {
  await page.goto(BASE_URL, { waitUntil: 'load' });
  await waitForSWActivated(page, context);
}

/**
 * Mutate the CACHE_VERSION in sw.js on disk to simulate a new deployment.
 * Returns a restore function that reverts the change.
 */
export function mutateSWVersion(swPath: string): () => void {
  const original = fs.readFileSync(swPath, 'utf-8');
  const mutated = original.replace(
    /const CACHE_VERSION = '[^']+'/,
    `const CACHE_VERSION = '${Date.now()}'`,
  );
  fs.writeFileSync(swPath, mutated);
  return () => fs.writeFileSync(swPath, original);
}
