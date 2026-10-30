/**
 * The SudoWall mark and name for interactive commands: four rounded quadrants, S top left and
 * W bottom right, in the brand's lime on ink. Printed only to a terminal, never into pipes or
 * the MCP stdio of `wrap`/`serve`, and plain when NO_COLOR is set.
 */
export function banner(version: string, env: NodeJS.ProcessEnv = process.env): string {
  const color = env['NO_COLOR'] === undefined || env['NO_COLOR'] === '';
  const truecolor = /truecolor|24bit/i.test(env['COLORTERM'] ?? '');
  const lime = truecolor ? '\x1b[38;2;217;242;80m' : '\x1b[38;5;191m';
  const limeBg = truecolor ? '\x1b[48;2;217;242;80m' : '\x1b[48;5;191m';
  const ink = '\x1b[38;5;232m';
  const orange = truecolor ? '\x1b[38;2;242;138;75m' : '\x1b[38;5;209m';
  const bold = '\x1b[1m';
  const dim = '\x1b[2m';
  const reset = '\x1b[0m';
  const c = (code: string, s: string) => (color ? `${code}${s}${reset}` : s);
  // Two rows of two cells: a lime "S" cell, a solid cell; a solid cell, a lime "W" cell.
  const s = c(limeBg + ink + bold, ' S ');
  const w = c(limeBg + ink + bold, ' W ');
  const block = c(lime, '███');
  return [
    '',
    `  ${s}${block}   ${c(bold, 'sudowall')} ${c(dim, version)}`,
    `  ${block}${w}   ${c(orange, 'Nothing moves until it’s checked.')}`,
    '',
  ].join('\n');
}

/** Prints the banner when stdout is a terminal. */
export function printBanner(version: string): void {
  if (process.stdout.isTTY) process.stdout.write(`${banner(version)}\n`);
}
