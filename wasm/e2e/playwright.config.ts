import path from 'path';
import { defineConfig } from '@playwright/test';

const DEV_PORT = 5173;

export default defineConfig({
  timeout: 60_000,
  workers: 1,
  projects: [
    {
      name: 'mock-tests',
      testDir: './tests',
      timeout: 30_000,
      expect: { timeout: 10_000 },
      use: {
        browserName: 'chromium',
        baseURL: `http://localhost:${DEV_PORT}`,
        trace: 'retain-on-failure',
      },
    },
    {
      name: 'sw-tests',
      testDir: '.',
      testMatch: 'sw-*.spec.ts',
      use: { browserName: 'chromium' },
    },
  ],
  webServer: {
    command: `npm run dev -- --port ${DEV_PORT}`,
    cwd: path.resolve(__dirname, '..'),
    port: DEV_PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
