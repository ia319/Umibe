import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test, vi } from 'vitest';
import { SqliteRunStore } from '@umibe/storage-sqlite';
import { runnerFixture } from '../../core/src/runtime/__tests__/runner-fixtures.js';
import { createAgent } from './index.js';

const directory = realpathSync.native(
  mkdtempSync(join(tmpdir(), 'umibe-sdk-')),
);
let counter = 0;

function fixture() {
  const h = runnerFixture();
  const projectRoot = join(directory, `project-${++counter}`);
  mkdirSync(projectRoot);
  return {
    h,
    options: {
      applicationId: 'sdk-fixture',
      projectRoot,
      actions: h.options.actions,
      planner: h.options.planner,
      environment: h.options.environment,
      candidateProvider: h.options.candidateProvider,
      selector: h.options.selector,
      verifier: h.options.verifier,
    },
  };
}

afterEach(() => vi.restoreAllMocks());

test('imports without creating files and runs memory mode without constructing a Worker', () => {
  const root = join(directory, `import-${++counter}`);
  mkdirSync(root);
  const entry = new URL('../dist/index.js', import.meta.url).href;
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { readdirSync } from 'node:fs';
    import workerThreads from 'node:worker_threads';
    import { syncBuiltinESMExports } from 'node:module';
    let workers = 0;
    const Worker = workerThreads.Worker;
    workerThreads.Worker = class extends Worker { constructor(...args) { workers++; super(...args); } };
    syncBuiltinESMExports();
    const { createAgent } = await import(process.env.UMIBE_SDK_ENTRY);
    assert.deepEqual(readdirSync('.'), []);
    const unused = async () => { throw new Error('Must not be invoked'); };
    const agent = createAgent({ persistence: { mode: 'memory' }, actions: [],
      planner: { plan: unused }, selector: { select: unused }, candidateProvider: { generate: unused },
      environment: { observe: unused }, verifier: { support: unused, verify: unused } });
    assert.equal((await agent.inspect()).kind, 'memory');
    assert.equal(await agent.inspect('absent'), null);
    await agent.close();
    assert.equal(workers, 0);
    assert.deepEqual(readdirSync('.'), []);
  `,
    ],
    {
      cwd: root,
      env: { ...process.env, UMIBE_SDK_ENTRY: entry },
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
});

test('defaults to SQLite and keeps absent-file queries free of initialization and ownership', async () => {
  const { h, options } = fixture();
  const agent = createAgent(options);
  const path = join(options.projectRoot, 'umibe.sqlite');
  expect(agent.storage).toEqual({ kind: 'sqlite', durable: true, path });
  expect(await agent.inspect()).toMatchObject({
    path,
    exists: false,
    owner: null,
  });
  expect(await agent.inspect('run')).toBeNull();
  expect(await agent.records('run', null, 10)).toEqual({
    records: [],
    nextCursor: null,
  });
  expect(existsSync(path)).toBe(false);
  await expect((await agent.start(h.input)).result).resolves.toMatchObject({
    status: 'succeeded',
  });
  const inspected = await agent.inspect('run');
  expect(inspected?.storage).toMatchObject({
    path,
    exists: true,
    owner: { pid: process.pid },
  });
  expect(Object.isFrozen(inspected?.storage)).toBe(true);
  await agent.close();
  const observer = createAgent(options);
  expect(await observer.inspect()).toMatchObject({
    path,
    exists: true,
    owner: null,
  });
  expect((await observer.inspect('run'))?.summary.status).toBe('succeeded');
  expect((await observer.inspect()).owner).toBeNull();
  await observer.close();
});

test('resolves the project root from initial cwd and retains it after cwd changes', async () => {
  const { options } = fixture();
  const nested = join(options.projectRoot, 'scripts');
  mkdirSync(nested);
  writeFileSync(join(options.projectRoot, 'package.json'), '{}', {
    encoding: 'utf8',
  });
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(nested);
  const { projectRoot, ...automatic } = options;
  const agent = createAgent(automatic);
  cwd.mockReturnValue(directory);
  expect(agent.storage.path).toBe(join(projectRoot, 'umibe.sqlite'));
  expect((await agent.inspect()).path).toBe(agent.storage.path);
  await agent.close();
});

test('closes only its own store reference and restores a paused run through a new agent', async () => {
  const { h, options } = fixture();
  const first = createAgent({ ...options, limits: { maxActionAttempts: 1 } });
  const second = createAgent(options);
  await expect((await first.start(h.input)).result).resolves.toMatchObject({
    status: 'paused',
  });
  const path = first.storage.path!;
  await first.close();
  expect((await second.inspect()).owner?.pid).toBe(process.pid);
  await expect(
    (await second.resume('run', { limits: { maxActionAttempts: 2 } })).result,
  ).resolves.toMatchObject({ status: 'succeeded' });
  expect(h.execute).toHaveBeenCalledTimes(2);
  await second.close();
  await second.close();
  const observer = new SqliteRunStore(path);
  expect((await observer.inspect()).owner).toBeNull();
  await observer.close();
});

test('rejects active close without releasing storage and remains usable after cancellation', async () => {
  const { h, options } = fixture();
  let entered!: () => void;
  const planning = new Promise<void>((resolve) => {
    entered = resolve;
  });
  h.plan.mockImplementation(() => {
    entered();
    return new Promise(() => undefined);
  });
  const agent = createAgent(options);
  const run = await agent.start(h.input);
  await planning;
  await expect(agent.close()).rejects.toMatchObject({ reason: 'agent_active' });
  expect((await agent.inspect()).owner?.pid).toBe(process.pid);
  await agent.cancel('run', 'test_complete');
  await run.result;
  await agent.close();
  await expect(agent.inspect()).rejects.toMatchObject({ code: 'STORE_CLOSED' });
});

test('preserves the configured location when initialization fails instead of changing stores', async () => {
  const { h, options } = fixture();
  const path = join(options.projectRoot, 'missing', 'run.sqlite');
  const agent = createAgent({
    ...options,
    persistence: { path: 'missing/run.sqlite' },
  });
  expect(agent.storage).toMatchObject({ kind: 'sqlite', path });
  await expect(agent.start(h.input)).rejects.toMatchObject({
    code: 'STORE_FAILED',
  });
  expect(existsSync(path)).toBe(false);
  expect(readdirSync(options.projectRoot, { encoding: 'utf8' })).toEqual([]);
  await agent.close();
});

test('rejects missing application identity, unknown modes and injected stores', () => {
  const { h, options } = fixture();
  expect(() => createAgent({ ...options, applicationId: '' })).toThrow(
    expect.objectContaining({ reason: 'missing_application_id' }),
  );
  expect(() =>
    createAgent({
      ...options,
      // @ts-expect-error Reject invalid JavaScript configuration at the public boundary.
      persistence: { mode: 'unknown' },
    }),
  ).toThrow();
  expect(() =>
    createAgent({
      ...options,
      // @ts-expect-error Memory mode does not accept a file path.
      persistence: { mode: 'memory', path: 'ignored.sqlite' },
    }),
  ).toThrow();
  // @ts-expect-error Custom store ownership belongs to the core entry point.
  expect(() => createAgent({ ...options, store: h.store })).toThrow();
  expect(readdirSync(options.projectRoot, { encoding: 'utf8' })).toEqual([]);
});

test('emits only production JavaScript and declarations', () => {
  const output = fileURLToPath(new URL('../dist/', import.meta.url));
  expect(
    readdirSync(output, { recursive: true, encoding: 'utf8' }).sort(),
  ).toEqual(['index.d.ts', 'index.js', 'path.d.ts', 'path.js']);
});
