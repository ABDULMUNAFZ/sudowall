// Spawned processes and large-index runs are slower on shared CI runners than locally.
export default { test: { testTimeout: 30_000 } };
