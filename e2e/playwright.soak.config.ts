import { defineConfig } from '@playwright/test';

// The soak starts its own backend and stand-in, but expects the frontend already up on 3011.
export default defineConfig({
  testDir: './soak',
  workers: 1,
  retries: 0,
  use: {
    baseURL: 'http://localhost:3011',
    channel: 'chrome',
    // No screencast: a failed game's trace was 257 MB with it.
    trace: { mode: 'retain-on-failure', screenshots: false },
    viewport: { width: 1280, height: 720 },
  },
  projects: [
    // Its own folder, so a unit run never wipes a game's folder mid-run.
    { name: 'unit', testMatch: /unit\/.*\.spec\.ts/, outputDir: 'test-results/unit' },
    { name: 'parts', testMatch: /parts\.spec\.ts/, timeout: 600_000 },
    { name: 'short', testMatch: /short\.spec\.ts/, timeout: 480_000 },
    { name: 'long', testMatch: /long\.spec\.ts/, timeout: 3_300_000 },
  ],
});
