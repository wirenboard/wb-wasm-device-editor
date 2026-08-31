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
          // CI runs the suite in a Docker container whose /dev/shm is the
          // 64 MB default; the Pyodide-heavy DALI specs fill it and the
          // renderer dies mid-suite ("browser has been closed") — the same
          // build passes everywhere with a real /dev/shm. Harmless locally.
          args: ['--disable-dev-shm-usage'],
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
