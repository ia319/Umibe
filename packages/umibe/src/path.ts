import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ContractError } from '@umibe/core';

/** Resolve once from the caller's initialization directory, without creating paths. */
export function resolveDatabasePath(
  projectRoot: string | undefined,
  path: string | undefined,
  cwd: string,
): string {
  for (const [name, value] of [
    ['projectRoot', projectRoot],
    ['persistence/path', path],
  ] as const)
    if (
      value !== undefined &&
      (typeof value !== 'string' || value.trim() === '' || value.includes('\0'))
    )
      throw new ContractError(
        'INVALID_RUN_CONTROL',
        'sdk',
        `/${name}`,
        'invalid_path',
      );
  let root = projectRoot === undefined ? cwd : resolve(cwd, projectRoot);
  if (projectRoot === undefined) {
    for (let ancestor = cwd; ; ancestor = dirname(ancestor)) {
      if (
        statSync(join(ancestor, 'package.json'), {
          throwIfNoEntry: false,
        })?.isFile()
      ) {
        root = ancestor;
        break;
      }
      if (dirname(ancestor) === ancestor) break;
    }
  }
  return resolve(root, path ?? 'umibe.sqlite');
}
