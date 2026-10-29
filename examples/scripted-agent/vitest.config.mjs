// Spawns Anvil, the gateway and two MCP servers; CI runners are slower than laptops.
export default { test: { testTimeout: 120_000, hookTimeout: 60_000 } };
