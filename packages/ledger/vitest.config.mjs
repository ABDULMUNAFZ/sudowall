// Spawned processes and property runs are slower on shared CI runners than locally.
export default { test: { testTimeout: 30_000 } };
