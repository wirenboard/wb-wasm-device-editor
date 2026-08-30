import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  workers: 1,
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
    {
      // The installed Google Chrome, for hosts where the playwright-managed
      // chromium download is unavailable: npx playwright test --project=system-chrome
      name: 'system-chrome',
      use: { browserName: 'chromium', channel: 'chrome' },
    },
  ],
});
