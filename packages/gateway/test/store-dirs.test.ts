import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultConfigDir, defaultStateDir } from '../src/store.js';

describe('state and config directories', () => {
  it.skipIf(process.platform === 'win32')(
    'use sudowall/, or tortoisegate/ when only that exists',
    () => {
      const base = mkdtempSync(join(tmpdir(), 'sw dirs '));
      const env = { XDG_STATE_HOME: join(base, 'state'), XDG_CONFIG_HOME: join(base, 'config') };
      expect(defaultStateDir(env)).toBe(join(base, 'state', 'sudowall'));
      expect(defaultConfigDir(env)).toBe(join(base, 'config', 'sudowall'));

      // Data from before the rename is used in place.
      mkdirSync(join(base, 'state', 'tortoisegate'), { recursive: true });
      mkdirSync(join(base, 'config', 'tortoisegate'), { recursive: true });
      expect(defaultStateDir(env)).toBe(join(base, 'state', 'tortoisegate'));
      expect(defaultConfigDir(env)).toBe(join(base, 'config', 'tortoisegate'));

      // Once the new directory exists, it wins.
      mkdirSync(join(base, 'state', 'sudowall'));
      expect(defaultStateDir(env)).toBe(join(base, 'state', 'sudowall'));
    },
  );
});
