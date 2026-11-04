// Each run gets its own temporary directory, removed afterwards (scripts/vitest-temp-dir.mjs).
export default { test: { globalSetup: ['../../scripts/vitest-temp-dir.mjs'] } };
