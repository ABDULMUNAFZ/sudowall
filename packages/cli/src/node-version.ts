// No imports: this runs before anything else is loaded, so an unsupported Node.js gets a plain
// message instead of an error from deep inside a dependency.

/**
 * Oldest supported Node.js. `@babel/parser` 8, which the Dodo read check uses, declares
 * `^22.18.0 || >=24.11.0`, and SudoWall is built and tested on Node.js 24 (ADR 0025).
 */
const MIN_MAJOR = 24;
const MIN_MINOR = 11;

/**
 * Returns the message to print when `version` (as in `process.version`, for example `v24.10.0`)
 * is older than SudoWall supports, or cannot be read; `undefined` when it is supported. Newer
 * major versions are accepted.
 */
export function nodeVersionProblem(version: string): string | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (m !== null) {
    const major = Number(m[1]);
    const minor = Number(m[2]);
    if (major > MIN_MAJOR || (major === MIN_MAJOR && minor >= MIN_MINOR)) return undefined;
  }
  const shown = version === '' ? 'an unknown version' : version;
  return `SudoWall needs Node.js ${MIN_MAJOR}.${MIN_MINOR} or newer (you have ${shown}). Update Node and run it again.`;
}
