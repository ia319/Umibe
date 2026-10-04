import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { resolveDatabasePath } from './path.js';

test('prefers an explicit root, then the nearest package root, then initial cwd', () => {
  const directory = realpathSync.native(
    mkdtempSync(join(tmpdir(), 'umibe-sdk-paths-')),
  );
  const outer = join(directory, 'application');
  const inner = join(outer, 'packages', 'nested');
  const cwd = join(inner, 'scripts');
  const override = join(directory, 'explicit');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(override);
  expect(resolveDatabasePath(undefined, undefined, cwd)).toBe(
    join(cwd, 'umibe.sqlite'),
  );
  writeFileSync(join(outer, 'package.json'), '{}', { encoding: 'utf8' });
  expect(resolveDatabasePath(undefined, undefined, cwd)).toBe(
    join(outer, 'umibe.sqlite'),
  );
  writeFileSync(join(inner, 'package.json'), '{}', { encoding: 'utf8' });
  expect(resolveDatabasePath(undefined, undefined, cwd)).toBe(
    join(inner, 'umibe.sqlite'),
  );
  expect(resolveDatabasePath(override, undefined, cwd)).toBe(
    join(override, 'umibe.sqlite'),
  );
  expect(resolveDatabasePath('..', 'data/run.sqlite', cwd)).toBe(
    join(inner, 'data/run.sqlite'),
  );
  expect(resolveDatabasePath(undefined, 'data/run.sqlite', cwd)).toBe(
    join(inner, 'data/run.sqlite'),
  );
  const absolute = join(directory, 'elsewhere.sqlite');
  expect(resolveDatabasePath(override, absolute, cwd)).toBe(absolute);
});

test.each(['', '   ', 'invalid\0path'])(
  'rejects an invalid configured path %j',
  (value) => {
    expect(() =>
      resolveDatabasePath(value, undefined, process.cwd()),
    ).toThrow();
    expect(() =>
      resolveDatabasePath(undefined, value, process.cwd()),
    ).toThrow();
  },
);
