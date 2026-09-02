import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  workers: 1,
  // A flaky spec reports as flaky, not as a red build.
  retries: process.env.CI ? 2 : 0,
  // Top level so system-chrome inherits it too. CI's chromium exposes
  // WebSerial even headless, and the first device access then falls through
  // to requestPort() without a gesture and kills the page; /dev/shm: Chrome
  // in Docker gets 64 MB, which the WASM-module specs outgrow.
  use: {
    launchOptions: {
      args: ['--disable-blink-features=Serial,WebUSB', '--disable-dev-shm-usage'],
    },
  },
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
