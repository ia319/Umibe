import { fork } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { OwnerCommand, OwnerReply } from './__tests__/owner-process.js';

const directory = mkdtempSync(join(tmpdir(), 'umibe-sqlite-process-'));
const children: { stop(): Promise<void> }[] = [];

async function ownerProcess(path: string) {
  const child = fork(
    new URL('./__tests__/owner-process.ts', import.meta.url),
    [path],
    { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let nextId = 0;
  let stderr = '';
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  let ready!: () => void;
  let rejectReady!: (error: Error) => void;
  const started = new Promise<void>((resolve, reject) => {
    ready = resolve;
    rejectReady = reject;
  });
  let stopped = false;
  const exited = new Promise<void>((resolve) => {
    child.once('exit', (code) => {
      stopped = true;
      const error = new Error(`Owner fixture exited with ${code}: ${stderr}`);
      rejectReady(error);
      for (const item of pending.values()) item.reject(error);
      pending.clear();
      resolve();
    });
  });
  child.once('error', rejectReady);
  child.on('message', (reply: OwnerReply) => {
    if (reply.id === 0) {
      ready();
      return;
    }
    const item = pending.get(reply.id);
    pending.delete(reply.id);
    if (reply.ok) item?.resolve(reply.value);
    else
      item?.reject(Object.assign(new Error(reply.error?.reason), reply.error));
  });
  const connection = {
    pid: child.pid,
    request(op: OwnerCommand): Promise<unknown> {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        child.send({ id, op }, (error) => {
          if (error !== null) {
            pending.delete(id);
            reject(error);
          }
        });
      });
    },
    async stop(): Promise<void> {
      if (!stopped) child.kill();
      await exited;
    },
  };
  children.push(connection);
  await started;
  return connection;
}

afterEach(async () => {
  await Promise.all(children.map((child) => child.stop()));
  children.length = 0;
});

test('allows exactly one process to initialize and own a new database', async () => {
  const path = join(directory, 'race.sqlite');
  const [first, second] = await Promise.all([
    ownerProcess(path),
    ownerProcess(path),
  ]);
  const claims = await Promise.allSettled([
    first.request('claim'),
    second.request('claim'),
  ]);
  expect(claims.filter((claim) => claim.status === 'fulfilled')).toHaveLength(
    1,
  );
  expect(claims.find((claim) => claim.status === 'rejected')).toMatchObject({
    reason: { code: 'STORE_OWNERSHIP', reason: 'process_owned' },
  });
  const owner = claims[0]?.status === 'fulfilled' ? first : second;
  const contender = owner === first ? second : first;
  await owner.request('write');
  expect(await contender.request('read')).toMatchObject({
    inspection: { owner: { pid: owner.pid } },
    run: { checkpoint: { revision: 1, state: { writerPid: owner.pid } } },
  });
  // Closing the store releases ownership while the old host process remains alive.
  await owner.request('close');
  await expect(contender.request('claim')).resolves.toMatchObject({
    pid: contender.pid,
  });
  await contender.request('close');
}, 15_000);

test('reads without claiming and takes over only after the previous host exits', async () => {
  const path = join(directory, 'takeover.sqlite');
  const owner = await ownerProcess(path);
  await owner.request('claim');
  await owner.request('write');
  const observer = await ownerProcess(path);
  expect(await observer.request('read')).toMatchObject({
    inspection: { owner: { pid: owner.pid } },
    run: { checkpoint: { revision: 1 } },
  });
  await expect(observer.request('claim')).rejects.toMatchObject({
    code: 'STORE_OWNERSHIP',
    reason: 'process_owned',
  });
  await owner.stop();
  expect(await observer.request('read')).toMatchObject({
    inspection: { owner: { pid: owner.pid } },
  });
  await expect(observer.request('claim')).resolves.toMatchObject({
    pid: observer.pid,
  });
  await observer.request('write');
  expect(await observer.request('read')).toMatchObject({
    inspection: { owner: { pid: observer.pid } },
    run: { checkpoint: { revision: 2, state: { writerPid: observer.pid } } },
  });
  await observer.request('close');
}, 15_000);
