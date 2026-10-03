import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { afterEach, expect, test, vi } from 'vitest';
import { createAgent } from '@umibe/core';
import { SqliteRunStore } from '@umibe/storage-sqlite';
import { runnerFixture } from '../../core/src/runtime/__tests__/runner-fixtures.js';
import { commit } from './__tests__/fixtures.js';

const directory = mkdtempSync(join(tmpdir(), 'umibe-sqlite-lifecycle-'));
let counter = 0;
const stores = new Set<SqliteRunStore>();
function store(path = join(directory, `${++counter}.sqlite`)): SqliteRunStore {
  const instance = new SqliteRunStore(path);
  stores.add(instance);
  return instance;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([...stores].map((item) => item.close()));
  stores.clear();
});

test('shares paths, fences run holders and closes only the releasing reference', async () => {
  const first = store();
  const second = store(relative(process.cwd(), first.info.path));
  const firstLease = await first.acquireRun('first');
  await expect(second.acquireRun('first')).rejects.toMatchObject({
    code: 'STORE_OWNERSHIP',
    reason: 'run_owned',
  });
  const secondLease = await second.acquireRun('second');
  await expect(second.commit(commit(firstLease, null))).rejects.toMatchObject({
    reason: 'invalid_owner',
  });
  const pending = first.commit(commit(firstLease, null));
  const closing = first.close();
  expect((await pending).outcome).toBe('committed');
  await closing;
  expect(firstLease.signal.aborted).toBe(true);
  expect(secondLease.signal.aborted).toBe(false);
  expect(second.signal.aborted).toBe(false);
  expect(await second.inspect()).toMatchObject({ owner: { pid: process.pid } });
  expect((await second.commit(commit(secondLease, null))).outcome).toBe(
    'committed',
  );
  const successor = await second.acquireRun('first');
  expect(successor.token).not.toBe(firstLease.token);
  await expect(second.commit(commit(firstLease, 1))).rejects.toMatchObject({
    reason: 'invalid_owner',
  });
  await second.commit(commit(successor, 1));
  await second.close();
  const observer = store(first.info.path);
  expect((await observer.inspect()).owner).toBeNull();
  expect((await observer.readRun('first'))?.checkpoint.revision).toBe(2);
});

test('reopening during final close waits for the previous Worker to release ownership', async () => {
  const first = store();
  await first.acquireRun('run');
  const closing = first.close();
  const next = store(first.info.path);
  const lease = await next.acquireRun('run');
  await closing;
  expect(lease.signal.aborted).toBe(false);
  expect((await next.commit(commit(lease, null))).outcome).toBe('committed');
});

test('closes an acquisition already in flight without leaking its run lease', async () => {
  const first = store();
  const second = store(first.info.path);
  const acquiring = first.acquireRun('run');
  const closing = first.close();
  expect((await acquiring).signal.aborted).toBe(true);
  await closing;
  expect((await second.acquireRun('run')).signal.aborted).toBe(false);
});

test('canonicalizes directory links before creating the database', async () => {
  const target = join(directory, 'target');
  const alias = join(directory, 'alias');
  mkdirSync(target);
  symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const first = store(join(alias, 'shared.sqlite'));
  const second = store(join(target, 'shared.sqlite'));
  expect(first.info.path).toBe(
    join(realpathSync.native(target), 'shared.sqlite'),
  );
  expect(first.info.path).toBe(second.info.path);
  await first.acquireRun('run');
  await expect(second.acquireRun('run')).rejects.toMatchObject({
    reason: 'run_owned',
  });
});

test.each(['direct', 'linked'])(
  'reports absent parents without creating or redirecting a %s path',
  async (route) => {
    const target = join(directory, `missing-parent-${route}`);
    mkdirSync(target);
    let inputRoot = target;
    if (route === 'linked') {
      inputRoot = join(directory, 'missing-parent-alias');
      symlinkSync(
        target,
        inputRoot,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    }
    const parent = join(inputRoot, 'absent-parent', 'nested');
    const database = store(join(parent, 'run.sqlite'));
    expect(await database.readRun('missing')).toBeNull();
    await expect(database.acquireRun('run')).rejects.toMatchObject({
      code: 'STORE_FAILED',
      reason: 'ENOENT',
    });
    expect(existsSync(join(target, 'absent-parent'))).toBe(false);
    expect(database.info.path).toBe(
      join(
        realpathSync.native(target),
        'absent-parent',
        'nested',
        'run.sqlite',
      ),
    );
  },
);

test('lets two Agents share the database without sharing a run', async () => {
  const h = runnerFixture(2);
  const firstStore = store();
  const secondStore = store(firstStore.info.path);
  let nextRunId = 'run';
  const options = {
    ...h.options,
    applicationId: 'storage-tests',
    environment: {
      async observe(
        context: Parameters<typeof h.observe>[0],
        control: Parameters<typeof h.observe>[1],
      ) {
        return {
          ...(await h.observe(context, control)),
          runId: context?.graph.runId ?? nextRunId,
        };
      },
    },
  };
  const first = createAgent({ ...options, store: firstStore });
  const second = createAgent({ ...options, store: secondStore });
  const run = await first.start(h.input);
  await run.result;
  await expect(second.start(h.input)).rejects.toMatchObject({
    reason: 'run_owned',
  });
  await first.close();
  expect(firstStore.signal.aborted).toBe(false);
  await firstStore.close();
  nextRunId = 'other';
  const other = await second.start({ ...h.input, runId: 'other' });
  await expect(other.result).resolves.toMatchObject({ status: 'succeeded' });
  await second.close();
  expect((await secondStore.readRun('run'))?.summary.status).toBe('succeeded');
});

test('rejects all pending calls and aborts idle leases after a Worker exits', async () => {
  const first = store();
  const second = store(first.info.path);
  const messages = vi.spyOn(Worker.prototype, 'postMessage');
  const firstLease = await first.acquireRun('first');
  const worker = messages.mock.contexts[0];
  if (!(worker instanceof Worker))
    throw new Error('Storage Worker was not started');
  messages.mockRestore();
  const secondLease = await second.acquireRun('second');
  // Hold delivery so both requests are unacknowledged when the real Worker exits.
  const delivery = vi
    .spyOn(Worker.prototype, 'postMessage')
    .mockImplementation(() => {});
  const pending = [
    first.readRun('first'),
    second.readRecords('second', null, 1),
  ];
  const outcomes = Promise.allSettled(pending);
  await Promise.resolve();
  await worker.terminate();
  delivery.mockRestore();
  for (const outcome of await outcomes)
    expect(outcome).toMatchObject({
      status: 'rejected',
      reason: { code: 'STORE_WORKER_FAILED' },
    });
  expect(firstLease.signal.aborted).toBe(true);
  expect(secondLease.signal.aborted).toBe(true);
  expect(first.signal.aborted).toBe(true);
  expect(second.signal.aborted).toBe(true);
  await expect(first.acquireRun('later')).rejects.toMatchObject({
    code: 'STORE_WORKER_FAILED',
  });
  await first.close();
  await second.close();
  const replacement = store(first.info.path);
  expect((await replacement.inspect()).owner?.pid).toBe(process.pid);
  await expect(replacement.acquireRun('later')).rejects.toMatchObject({
    reason: 'process_owned',
  });
});

test('checks the persisted process token before writing and preserves a replacement owner', async () => {
  const database = store();
  const lease = await database.acquireRun('run');
  const raw = new Database(database.info.path);
  try {
    raw.prepare('UPDATE runtime_owner SET token = ?').run('replacement');
    await expect(database.commit(commit(lease, null))).rejects.toMatchObject({
      reason: 'process_owner_lost',
    });
    expect(database.signal.aborted).toBe(true);
    expect(lease.signal.aborted).toBe(true);
    expect(raw.prepare('SELECT * FROM runs').all()).toEqual([]);
    await database.close();
    expect(raw.prepare('SELECT token FROM runtime_owner').get()).toEqual({
      token: 'replacement',
    });
  } finally {
    raw.close();
  }
});

test('stops both Agents after their shared Worker exits and ignores late model responses', async () => {
  const h = runnerFixture();
  const originalPlan = h.plan.getMockImplementation();
  if (originalPlan === undefined) throw new Error('Missing fixture planner');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let bothEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    bothEntered = resolve;
  });
  let planning = 0;
  h.plan.mockImplementation(async (request, control) => {
    if (++planning === 2) bothEntered();
    await gate;
    return originalPlan(request, control);
  });
  const firstStore = store();
  const secondStore = store(firstStore.info.path);
  let initializingRun = 'run';
  const options = {
    ...h.options,
    applicationId: 'worker-failure-tests',
    modelStages: ['planning'] as const,
    environment: {
      async observe(
        context: Parameters<typeof h.observe>[0],
        control: Parameters<typeof h.observe>[1],
      ) {
        return {
          ...(await h.observe(context, control)),
          runId: context?.graph.runId ?? initializingRun,
        };
      },
    },
  };
  const first = createAgent({ ...options, store: firstStore });
  const second = createAgent({ ...options, store: secondStore });
  const messages = vi.spyOn(Worker.prototype, 'postMessage');
  const one = await first.start(h.input);
  const worker = messages.mock.contexts[0];
  messages.mockRestore();
  if (!(worker instanceof Worker))
    throw new Error('Storage Worker was not started');
  initializingRun = 'other';
  const two = await second.start({ ...h.input, runId: 'other' });
  const results = Promise.allSettled([one.result, two.result]);
  await entered;
  await worker.terminate();
  release();
  for (const outcome of await results)
    expect(outcome).toMatchObject({
      status: 'rejected',
      reason: { reason: 'store_failed' },
    });
  expect(h.plan).toHaveBeenCalledTimes(2);
  expect(h.generate).not.toHaveBeenCalled();
  expect(h.select).not.toHaveBeenCalled();
  expect(h.execute).not.toHaveBeenCalled();
  await first.close();
  await second.close();
});

test('refuses to release a process record whose token has changed', async () => {
  const database = store();
  await database.acquireRun('run');
  const raw = new Database(database.info.path);
  try {
    raw.prepare('UPDATE runtime_owner SET token = ?').run('replacement');
    await expect(database.close()).rejects.toMatchObject({
      reason: 'process_owner_lost',
    });
    stores.delete(database);
    expect(raw.prepare('SELECT token FROM runtime_owner').get()).toEqual({
      token: 'replacement',
    });
  } finally {
    raw.close();
  }
});
