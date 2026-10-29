// Points git at the versioned hooks in .githooks. Runs on `pnpm install` via the prepare script.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (process.env.CI) process.exit(0);
if (!existsSync('.git')) process.exit(0);
execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'inherit' });
