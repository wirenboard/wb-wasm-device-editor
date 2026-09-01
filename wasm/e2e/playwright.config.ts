import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  workers: 1,
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        launchOptions: {
          // No hardware in e2e: with WebSerial exposed (CI's chromium image
          // has it even headless), the first device access falls through to
          // requestPort() without a user gesture and the page dies — the
          // trace from the CI runner ends 300 ms after "Using native
          // WebSerial API". Disabling the APIs makes every environment
          // behave like the specs assume. /dev/shm: the Docker default
          // 64 MB is too small for the Pyodide-heavy specs.
          args: ['--disable-blink-features=Serial,WebUSB', '--disable-dev-shm-usage'],
        },
      },
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
