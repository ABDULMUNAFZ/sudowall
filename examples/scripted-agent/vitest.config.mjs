// Spawns Anvil, the gateway and two MCP servers; CI runners are slower than laptops.
// Each run gets its own temporary directory, removed afterwards (scripts/vitest-temp-dir.mjs).
export default {
  test: {
    testTimeout: 120_000,
    hookTimeout: 60_000,
    globalSetup: ['../../scripts/vitest-temp-dir.mjs'],
  },
};
