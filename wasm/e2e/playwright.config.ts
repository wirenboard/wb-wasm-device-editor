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
    // The installed Google Chrome, for hosts where the playwright-managed
    // chromium download is unavailable. Opt-in (PW_SYSTEM_CHROME=1 npx
    // playwright test --project=system-chrome): running it by default doubles
    // every spec and fails wholesale wherever google-chrome is not installed —
    // CI included.
    ...(process.env.PW_SYSTEM_CHROME
      ? [{
        name: 'system-chrome',
        use: { browserName: 'chromium' as const, channel: 'chrome' },
      }]
      : []),
  ],
});
