import { defineConfig } from '@playwright/test';

// The soak starts its own backend and stand-in, but expects the frontend already up on 3011.
export default defineConfig({
  testDir: './soak',
  workers: 1,
  retries: 0,
  use: {
    baseURL: 'http://localhost:3011',
    channel: 'chrome',
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 720 },
  },
  projects: [
    { name: 'unit', testMatch: /unit\/.*\.spec\.ts/ },
    { name: 'parts', testMatch: /parts\.spec\.ts/, timeout: 600_000 },
    { name: 'short', testMatch: /short\.spec\.ts/, timeout: 480_000 },
    { name: 'long', testMatch: /long\.spec\.ts/, timeout: 3_300_000 },
  ],
});
