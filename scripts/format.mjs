import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const options = process.argv.slice(2);
// Git resolves local exclude patterns relative to the repository root.
const files = [
  ...new Set(
    execFileSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { encoding: 'utf8' },
    ).split('\0'),
  ),
].filter(
  (file) =>
    /\.(?:js|mjs|cjs|jsx|ts|mts|cts|tsx|json|jsonc|yaml|yml|md)$/.test(file) &&
    lstatSync(file, { throwIfNoEntry: false })?.isFile(),
);
const prettier = fileURLToPath(
  import.meta.resolve('prettier/bin/prettier.cjs'),
);

for (let start = 0; start < files.length;) {
  let end = start;
  let length = 0;
  // Bound batches so large repositories stay below Windows' command-line limit.
  while (end < files.length && length < 8_000) {
    length += (files[end]?.length ?? 0) + 3;
    end += 1;
  }

  const result = spawnSync(
    process.execPath,
    [prettier, ...options, '--', ...files.slice(start, end)],
    { stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  if (result.signal) {
    throw new Error(`Prettier terminated with ${result.signal}.`);
  }
  process.exitCode = Math.max(
    Number(process.exitCode ?? 0),
    result.status ?? 2,
  );
  start = end;
}
