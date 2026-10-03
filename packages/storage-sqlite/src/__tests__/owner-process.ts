import { SqliteRunStore } from '@umibe/storage-sqlite';
import type { RunLease } from '@umibe/core';

export type OwnerCommand = 'claim' | 'write' | 'read' | 'close';
export interface OwnerReply {
  readonly id: number;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: { readonly code: string; readonly reason: string };
}

const path = process.argv[2];
if (path === undefined)
  throw new Error('The owner fixture requires a database path');
const store = new SqliteRunStore(path);
let lease: RunLease | undefined;

async function execute(op: OwnerCommand): Promise<unknown> {
  switch (op) {
    case 'claim':
      lease = await store.acquireRun('run');
      return { pid: process.pid, token: lease.token };
    case 'write': {
      if (lease === undefined)
        throw new Error('Acquire the fixture run before writing');
      const previous = await store.readRun('run');
      return store.commit({
        ownerToken: lease.token,
        runId: 'run',
        expectedRevision: previous?.checkpoint.revision ?? null,
        status: 'running',
        rootGoalRef: { id: 'root', version: 1 },
        currentGoalRef: { id: 'root', version: 1 },
        stateSchemaVersion: 1,
        state: { writerPid: process.pid },
        records: [],
      });
    }
    case 'read':
      return {
        inspection: await store.inspect(),
        run: await store.readRun('run'),
      };
    case 'close':
      await store.close();
      return null;
  }
}

process.on('message', (message: { id: number; op: OwnerCommand }) => {
  void execute(message.op).then(
    (value) => {
      process.send?.({ id: message.id, ok: true, value } satisfies OwnerReply);
    },
    (error: unknown) => {
      const code =
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof error.code === 'string'
          ? error.code
          : 'FIXTURE_FAILED';
      const reason =
        typeof error === 'object' &&
        error !== null &&
        'reason' in error &&
        typeof error.reason === 'string'
          ? error.reason
          : String(error);
      process.send?.({
        id: message.id,
        ok: false,
        error: { code, reason },
      } satisfies OwnerReply);
    },
  );
});
process.send?.({
  id: 0,
  ok: true,
  value: { pid: process.pid },
} satisfies OwnerReply);
