#!/usr/bin/env node
// The `sudowall` command. It checks the Node.js version before it loads the rest of SudoWall:
// static imports are loaded before a module's own code runs, so the check cannot live in
// main.ts. Keep this file and node-version.ts free of other imports.
import { nodeVersionProblem } from './node-version.js';

const problem = nodeVersionProblem(process.version);
if (problem !== undefined) {
  process.stderr.write(`${problem}\n`);
  process.exit(1);
}

const { run } = await import('./main.js');
run(process.argv.slice(2));
