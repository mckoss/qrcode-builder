import { defineConfig, devices } from '@playwright/test';

// End-to-end tests run against a production build served under the same base path as GitHub Pages,
// so service-worker, manifest and asset-path behavior match what users get.
const BASE_PATH = '/qrcode-builder/';
const PORT = 4174;

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.e2e.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  timeout: 30_000,
  use: {
    baseURL: `http://localhost:${PORT}${BASE_PATH}`,
    // Most tests don't want the service worker in the way; the offline tests opt back in.
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Separate outDir so this never clobbers the deploy build in dist/.
    command: `npx vite build --outDir dist-e2e && npx vite preview --outDir dist-e2e --port ${PORT} --strictPort`,
    env: { BASE_PATH },
    url: `http://localhost:${PORT}${BASE_PATH}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
