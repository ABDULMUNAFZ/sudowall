import { ProtocolError, SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { demoCallError } from '../src/demo.js';
import { RuntimeError } from '../src/errors.js';
import { EXIT, fail } from '../src/main.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/** What `fail` prints to stderr for an error, and the exit code it returns. */
function printed(e: unknown): { text: string; code: number } {
  let text = '';
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    text += String(chunk);
    return true;
  });
  const code = fail(e);
  vi.restoreAllMocks();
  return { text, code };
}

describe('demo: errors from a tool call', () => {
  it('a JSON-RPC error from the gateway is one line, without a stack trace', () => {
    const e = demoCallError(
      'send_funds',
      ProtocolError.fromError(-32003, 'request timed out after 600000 ms'),
    );
    expect(e).toBeInstanceOf(RuntimeError);
    const { text, code } = printed(e);
    expect(text).toBe(
      'sudowall: demo: the gateway answered send_funds with an error: request timed out after 600000 ms (-32003)\n',
    );
    expect(code).toBe(EXIT.runtime);
  });

  it('the MCP client giving up is one line too', () => {
    const e = demoCallError(
      'send_funds',
      new SdkError(SdkErrorCode.RequestTimeout, 'Request timed out'),
    );
    const { text } = printed(e);
    expect(text).toBe(
      'sudowall: demo: the MCP client stopped waiting for send_funds: Request timed out\n',
    );
  });

  it('any other error keeps its stack trace for a bug report', () => {
    const bug = new TypeError('x is undefined');
    expect(demoCallError('send_funds', bug)).toBe(bug);
    const { text } = printed(bug);
    expect(text.split('\n').length).toBeGreaterThan(2);
    expect(text).toContain('    at ');
  });
});
