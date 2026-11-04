import { describe, expect, it } from 'vitest';
import { approvalWords } from './describe.js';

describe('approvalWords', () => {
  it('says an approved call ran only when the gateway released it', () => {
    expect(approvalWords('approved', 'allow')).toBe('You approved it, so it ran.');
    expect(approvalWords('approved', 'block')).toBe(
      'You approved it too late: the call had already been cancelled or its session closed, so it never ran.',
    );
  });

  it('keeps the denied and timed-out sentences', () => {
    expect(approvalWords('denied', 'block')).toBe('You denied it, so it never ran.');
    expect(approvalWords('timed-out', 'block')).toBe(
      'timed-out: nobody decided in time, so it never ran.',
    );
    expect(approvalWords('timed-out', 'allow')).toBe('timed-out: it ran.');
  });
});
