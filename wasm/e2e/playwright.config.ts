import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  use: {
    // CI's chromium exposes WebSerial even headless, and the first device access
    // then falls through to requestPort() without a gesture and kills the page.
    // Chrome in Docker gets 64 MB of /dev/shm, which the WASM specs outgrow
    launchOptions: {
      args: ['--disable-blink-features=Serial,WebUSB', '--disable-dev-shm-usage'],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
    // Opt-in (PW_SYSTEM_CHROME=1 npx playwright test --project=system-chrome) for
    // hosts without the playwright-managed chromium download
    ...(process.env.PW_SYSTEM_CHROME
      ? [{
        name: 'system-chrome',
        use: { browserName: 'chromium' as const, channel: 'chrome' },
      }]
      : []),
  ],
});
