import { expect, test, vi } from 'vitest';
import { generationInput } from '#internal/candidate/__tests__/fixtures';
import { MemoryRunStore } from '#internal/storage/memory';
import type {
  CommitResult,
  RunCommit,
  RunStore,
} from '#internal/storage/contracts';
import { RunSession } from './session.js';

test('fails an idle session when its store closes without another commit', async () => {
  const store = new MemoryRunStore();
  const diagnose = vi.fn();
  const session = await RunSession.create(store, generationInput(), diagnose);
  await session.transition({ kind: 'start' });
  await store.close();
  expect(session.canDispatch(3)).toBe(false);
  expect(session.signal.aborted).toBe(true);
  await expect(session.result).rejects.toMatchObject({
    reason: 'store_failed',
  });
  expect(diagnose).toHaveBeenCalledWith(
    expect.objectContaining({ code: 'store_failed' }),
  );
  await session.close();
});

test('releases ownership after a failed initialization', async () => {
  const store = new MemoryRunStore();
  vi.spyOn(store, 'commit').mockRejectedValueOnce(new Error('write failed'));
  await expect(
    RunSession.create(store, generationInput(), vi.fn()),
  ).rejects.toThrow('write failed');
  const next = await RunSession.create(store, generationInput(), vi.fn());
  expect(next.checkpoint?.revision).toBe(1);
  await next.close();
});

test('admits cancellation while a commit is pending and publishes only committed records', async () => {
  const memory = new MemoryRunStore();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const store: RunStore = {
    info: memory.info,
    signal: memory.signal,
    acquireRun: memory.acquireRun.bind(memory),
    readRecord: memory.readRecord.bind(memory),
    readRun: memory.readRun.bind(memory),
    readRecords: memory.readRecords.bind(memory),
    close: memory.close.bind(memory),
    async commit(input) {
      if (input.status === 'running') await gate;
      return memory.commit(input);
    },
  };
  const session = await RunSession.create(store, generationInput(), vi.fn());
  const seen: number[] = [];
  session.subscribe((record) => {
    seen.push(record.sequence);
  });
  const start = session.transition({ kind: 'start' });
  expect(session.checkpoint?.status).toBe('created');
  const cancel = session.transition({
    kind: 'cancel',
    cause: { eventId: 'stop', reasonCode: 'user_cancelled' },
  });
  expect(session.state.control.status).toBe('cancelling');
  expect(session.signal.aborted).toBe(true);
  expect(session.canDispatch(3)).toBe(false);
  expect(seen).toEqual([]);
  release();
  await Promise.all([start, cancel]);
  await session.transition({ kind: 'stopSettled', blocker: null });
  await expect(session.result).resolves.toMatchObject({ status: 'cancelled' });
  expect(seen).toEqual([2, 3, 4, 5]);
  expect(session.checkpoint?.status).toBe('cancelled');
});

test('preserves cancellation cleanup failures in the final result and checkpoint', async () => {
  const session = await RunSession.create(
    new MemoryRunStore(),
    generationInput(),
    vi.fn(),
  );
  await session.transition({ kind: 'start' });
  const cause = { eventId: 'cancel', reasonCode: 'user_cancelled' };
  const blocker = { eventId: 'cleanup', reasonCode: 'cleanup_failed' };
  await session.transition({ kind: 'cancel', cause });
  await session.transition({ kind: 'fail', cause: blocker });
  await session.transition({ kind: 'stopSettled', blocker: null });

  const expected = { status: 'cancelled', stopCause: cause, blocker };
  await expect(session.result).resolves.toMatchObject(expected);
  expect(session.checkpoint?.state.control).toMatchObject(expected);
  await session.close();
});

test.each(['reject', 'conflict'] as const)(
  'fails closed on store %s without reporting an uncommitted checkpoint',
  async (mode) => {
    const memory = new MemoryRunStore();
    const diagnose = vi.fn();
    let writes = 0;
    const store: RunStore = {
      info: memory.info,
      signal: memory.signal,
      acquireRun: memory.acquireRun.bind(memory),
      readRecord: memory.readRecord.bind(memory),
      readRun: memory.readRun.bind(memory),
      readRecords: memory.readRecords.bind(memory),
      close: memory.close.bind(memory),
      commit(input: RunCommit): Promise<CommitResult> {
        writes++;
        if (writes === 1) return memory.commit(input);
        if (mode === 'conflict')
          return Promise.resolve({ outcome: 'conflict', actualRevision: 99 });
        return Promise.reject(new Error('disk unavailable'));
      },
    };
    const session = await RunSession.create(store, generationInput(), diagnose);
    const seen = vi.fn();
    session.subscribe(seen);
    const first = session.transition({ kind: 'start' });
    const second = session.transition({
      kind: 'pause',
      cause: { eventId: 'pause', reasonCode: 'user_pause' },
    });
    await expect(first).rejects.toThrow();
    await expect(second).rejects.toThrow();
    await expect(session.result).rejects.toThrowError(
      expect.objectContaining({
        reason: mode === 'conflict' ? 'store_conflict' : 'store_failed',
      }),
    );
    expect(session.checkpoint?.status).toBe('created');
    expect(session.signal.aborted).toBe(true);
    expect(session.canDispatch(3)).toBe(false);
    expect(writes).toBe(2);
    expect(seen).not.toHaveBeenCalled();
    expect(diagnose).toHaveBeenCalledTimes(1);
  },
);

test('isolates throwing subscribers and rejects duplicate ownership without closing the shared store', async () => {
  const store = new MemoryRunStore();
  const diagnose = vi.fn();
  const first = await RunSession.create(store, generationInput(), diagnose);
  await expect(
    RunSession.create(store, generationInput(), diagnose),
  ).rejects.toThrowError(expect.objectContaining({ reason: 'run_owned' }));
  first.subscribe(() => {
    throw new Error('observer');
  });
  const seen = vi.fn();
  const unsubscribe = first.subscribe(seen);
  await first.transition({ kind: 'start' });
  expect(seen).toHaveBeenCalledTimes(1);
  expect(diagnose).toHaveBeenCalledWith(
    expect.objectContaining({ code: 'subscriber_failed' }),
  );
  await expect(first.close()).rejects.toThrowError(
    expect.objectContaining({ reason: 'run_active' }),
  );
  unsubscribe();
  await first.transition({
    kind: 'pause',
    cause: { eventId: 'pause', reasonCode: 'user_pause' },
  });
  await first.transition({ kind: 'stopSettled', blocker: null });
  await first.close();
  await first.close();
  expect((await store.readRun('run'))?.summary.status).toBe('paused');
});

test('resuming starts a fresh result interval and ordinary observations retain the decision epoch', async () => {
  const session = await RunSession.create(
    new MemoryRunStore(),
    generationInput(),
    vi.fn(),
  );
  await session.transition({ kind: 'start' });
  const decision = generationInput();
  await session.replaceDecision({
    ...decision,
    context: {
      ...decision.context,
      observation: { ...decision.context.observation, revision: 5 },
    },
  });
  expect(session.canDispatch(3)).toBe(true);
  const firstResult = session.result;
  const firstSignal = session.signal;
  await session.transition({
    kind: 'pause',
    cause: { eventId: 'pause', reasonCode: 'needs_input' },
  });
  await session.transition({ kind: 'stopSettled', blocker: null });
  await expect(firstResult).resolves.toMatchObject({ status: 'paused' });
  await session.transition({ kind: 'resume' });
  expect(session.result).not.toBe(firstResult);
  expect(session.signal).not.toBe(firstSignal);
  expect(session.canDispatch(3)).toBe(true);
  await session.replaceDecision({ ...decision, decisionEpoch: 4 });
  expect(session.canDispatch(3)).toBe(false);
  await expect(session.replaceDecision(decision)).rejects.toThrowError(
    expect.objectContaining({ reason: 'stale_or_foreign_decision' }),
  );
});
