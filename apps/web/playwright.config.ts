import { defineConfig } from '@playwright/test';

const API_PORT = 4100;
const WEB_PORT = 5273;

export default defineConfig({
  testDir: './e2e',
  // Tests share one in-memory server, so run them one at a time.
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    viewport: { width: 1360, height: 800 },
    trace: 'retain-on-failure',
  },
  // Playwright starts a fresh server + web app for the test run.
  // The simulator is off so nothing changes unless a test changes it.
  webServer: [
    {
      command: 'npm run start -w @quickhub/server',
      cwd: '../..',
      url: `http://localhost:${API_PORT}/api/health`,
      env: { PORT: String(API_PORT), SIMULATOR: 'off', LATENCY_MS: '0' },
      reuseExistingServer: false,
    },
    {
      command: 'npm run dev -w @quickhub/web',
      cwd: '../..',
      url: `http://localhost:${WEB_PORT}`,
      env: { WEB_PORT: String(WEB_PORT), API_PROXY_TARGET: `http://localhost:${API_PORT}` },
      reuseExistingServer: false,
    },
  ],
});
