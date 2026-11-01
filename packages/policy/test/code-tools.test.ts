import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codeExecutionTools, compilePolicy, loadPolicyFile } from '../src/index.js';

const template = (name: string) =>
  loadPolicyFile(fileURLToPath(new URL(`../templates/${name}.yaml`, import.meta.url)));

const policy = (rules: unknown[], sinks: unknown[] = []) =>
  compilePolicy({ schema: 'sudowall/policy@1', name: 't', version: 1, sinks, rules });

const READ = { sdk_read_only: { resources: ['payments'] } };

describe('codeExecutionTools', () => {
  it('finds Dodo execute in the dodo-payments template', () => {
    expect(codeExecutionTools(template('dodo-payments'))).toEqual([
      { server: '*', tool: 'execute' },
    ]);
  });

  it('finds none in the everyday and money-moving templates', () => {
    expect(codeExecutionTools(template('everyday'))).toEqual([]);
    expect(codeExecutionTools(template('money-moving'))).toEqual([]);
  });

  it('finds sdk_read_only nested under not, all and any, once per server and tool', () => {
    const p = policy([
      {
        id: 'a',
        match: { server: 'dodo', tool: 'run' },
        when: { not: { all: [{ any: [{ path: '/code', ...READ }] }] } },
        action: 'ask',
        reason: 'r',
      },
      {
        id: 'b',
        match: { server: 'dodo', tool: 'run' },
        when: { path: '/code', ...READ },
        action: 'allow',
        reason: 'r',
      },
      { id: 'c', match: { tool: 'other' }, action: 'allow', reason: 'r' },
    ]);
    expect(codeExecutionTools(p)).toEqual([{ server: 'dodo', tool: 'run' }]);
  });

  it('leaves out sink rules: a policy error on a sink call always blocks', () => {
    const p = policy(
      [
        {
          id: 'a',
          match: { sink: 'pay' },
          when: { arg: 'code', ...READ },
          action: 'allow',
          reason: 'r',
        },
      ],
      [{ id: 'pay', tool: 'execute', args: { code: { path: '/code', kind: 'url' } } }],
    );
    expect(codeExecutionTools(p)).toEqual([]);
  });
});
