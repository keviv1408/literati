import { defineConfig } from '@playwright/test';

// Expects both dev servers already running: backend on 3012, frontend on 3011.
export default defineConfig({
  testDir: './tests',
  timeout: 120_000,
  workers: 1,
  use: {
    baseURL: 'http://localhost:3011',
    channel: 'chrome',
  },
});
