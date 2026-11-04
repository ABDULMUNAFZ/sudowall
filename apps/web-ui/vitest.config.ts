import { defineConfig } from 'vitest/config';

// Unit tests only; the Playwright specs in e2e/ run with `pnpm test:e2e`.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Each run gets its own temporary directory, removed afterwards.
    globalSetup: ['../../scripts/vitest-temp-dir.mjs'],
  },
});
