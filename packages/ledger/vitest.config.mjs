// Spawned processes and property runs are slower on shared CI runners than locally.
// Each run gets its own temporary directory, removed afterwards (scripts/vitest-temp-dir.mjs).
export default {
  test: { testTimeout: 30_000, globalSetup: ['../../scripts/vitest-temp-dir.mjs'] },
};
