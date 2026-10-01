import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execPath } from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const packageRoot = join(repositoryRoot, 'packages/core');
const compilerPath = fileURLToPath(import.meta.resolve('typescript/bin/tsc'));
const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) {
  throw new Error(
    'Run pack:check through pnpm so its pinned CLI is available.',
  );
}
const pnpmIsScript = /\.(?:cjs|mjs|js)$/.test(pnpmCli);
const pnpmCommand = pnpmIsScript ? execPath : pnpmCli;
const pnpmArguments = pnpmIsScript ? [pnpmCli] : [];

/** @param {string[]} args */
function runPnpm(args) {
  return execFileSync(pnpmCommand, [...pnpmArguments, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    timeout: 120_000,
  });
}

/** @param {unknown} value */
function checkPackManifest(value) {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('filename' in value) ||
    typeof value.filename !== 'string' ||
    !('files' in value) ||
    !Array.isArray(value.files)
  ) {
    throw new Error('pnpm pack returned an invalid manifest.');
  }
  const paths = value.files.map((/** @type {unknown} */ file) => {
    if (
      typeof file !== 'object' ||
      file === null ||
      !('path' in file) ||
      typeof file.path !== 'string'
    ) {
      throw new Error('pnpm pack returned an invalid file entry.');
    }
    return file.path;
  });
  assert.equal(new Set(paths).size, paths.length, 'duplicate archive path');
  for (const path of paths) {
    assert.match(path, /^(?:package\.json|dist\/.+\.(?:js|d\.ts))$/);
    assert.doesNotMatch(
      path,
      /(^|\/)(?:tests?|__tests__|fixtures)(\/|$)|\.(?:test(?:-d)?|spec)\./,
    );
  }
  for (const path of ['package.json', 'dist/index.js', 'dist/index.d.ts']) {
    assert.ok(paths.includes(path), `missing archive entry: ${path}`);
  }
  return value.filename;
}

const temporaryParent = realpathSync(tmpdir());
const temporaryRoot = mkdtempSync(join(temporaryParent, 'umibe-pack-check-'));
try {
  const consumerRoot = join(temporaryRoot, 'consumer');
  console.log(`Package validation workspace: ${temporaryRoot}`);

  const packed = /** @type {unknown} */ (
    JSON.parse(
      runPnpm([
        '--dir',
        packageRoot,
        'pack',
        '--json',
        '--pack-destination',
        temporaryRoot,
      ]),
    )
  );
  const tarball = resolve(temporaryRoot, checkPackManifest(packed));
  assert.equal(dirname(tarball), temporaryRoot);
  assert.ok(existsSync(tarball), 'pnpm pack did not create the archive');

  // The consumer lives outside the workspace, so package exports and dependencies
  // must resolve from the installed archive rather than source aliases.
  mkdirSync(consumerRoot);
  writeFileSync(
    join(consumerRoot, 'package.json'),
    JSON.stringify({
      name: 'umibe-pack-consumer',
      private: true,
      type: 'module',
    }),
    { encoding: 'utf8' },
  );
  runPnpm([
    '--dir',
    consumerRoot,
    '--store-dir',
    runPnpm(['store', 'path']).trim(),
    '--ignore-workspace',
    'add',
    '--offline',
    '--ignore-scripts',
    tarball,
  ]);

  writeFileSync(
    join(consumerRoot, 'consumer.mjs'),
    `import assert from 'node:assert/strict';
import { MemoryRunStore, parseJsonValue } from '@umibe/core';

const snapshot = parseJsonValue({ ready: true }, 'consumer');
assert.equal(Object.getPrototypeOf(snapshot), null);
assert.equal(snapshot.constructor, undefined);
assert.deepEqual(Object.entries(snapshot), [['ready', true]]);
const store = new MemoryRunStore();
try {
  const result = await store.commit({
    runId: 'consumer-run',
    expectedRevision: null,
    status: 'running',
    rootGoalRef: { id: 'root', version: 1 },
    currentGoalRef: { id: 'root', version: 1 },
    stateSchemaVersion: 1,
    state: { phase: 'started' },
    records: [],
  });
  assert.equal(result.outcome, 'committed');
  assert.equal((await store.readRun('consumer-run'))?.checkpoint.revision, 1);
  assert.deepEqual(await store.readRecords('consumer-run', null, 1), {
    records: [],
    nextCursor: null,
  });
  await assert.rejects(import('@umibe/core/dist/index.js'), {
    code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
  });
} finally {
  await store.close();
}
`,
    { encoding: 'utf8' },
  );

  writeFileSync(
    join(consumerRoot, 'consumer.mts'),
    `import { MemoryRunStore, type RecordPage, type RunCommit } from '@umibe/core';

const input: RunCommit = {
  runId: 'consumer-run',
  expectedRevision: null,
  status: 'running',
  rootGoalRef: { id: 'root', version: 1 },
  currentGoalRef: { id: 'root', version: 1 },
  stateSchemaVersion: 1,
  state: { phase: 'started' },
  records: [],
};
const store = new MemoryRunStore();
const page: Promise<RecordPage> = store.readRecords(input.runId, null, 1);
void page;
`,
    { encoding: 'utf8' },
  );
  writeFileSync(
    join(consumerRoot, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        noEmit: true,
        strict: true,
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        target: 'ES2023',
        types: [],
      },
      files: ['consumer.mts'],
    }),
    { encoding: 'utf8' },
  );

  execFileSync(execPath, [join(consumerRoot, 'consumer.mjs')], {
    cwd: consumerRoot,
    encoding: 'utf8',
    stdio: 'inherit',
    timeout: 15_000,
  });
  execFileSync(execPath, [compilerPath, '-p', 'tsconfig.json'], {
    cwd: consumerRoot,
    encoding: 'utf8',
    stdio: 'inherit',
    timeout: 30_000,
  });
  console.log(
    'Archive contents, ESM import, runtime behavior, and types passed.',
  );
} finally {
  assert.equal(dirname(realpathSync(temporaryRoot)), temporaryParent);
  rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 3 });
}
