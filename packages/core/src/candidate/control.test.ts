import { getEventListeners } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import type {
  CallControl,
  CandidateRequest,
} from '#internal/contracts/adapters';
import { captureControl, invokeControlled } from './control.js';
import { prepareCandidates } from './prepare.js';
import {
  actionRegistry,
  callControl,
  candidateSet,
  generationInput,
} from './__tests__/fixtures.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('rejects malformed deadlines and skips already cancelled or expired invocations', async () => {
  const parent = new AbortController();
  const callback = vi.fn(() => Promise.resolve('value'));
  expect(() =>
    captureControl({ signal: parent.signal, deadlineAt: 'tomorrow' }),
  ).toThrowError(expect.objectContaining({ path: '/control/deadlineAt' }));
  parent.abort();
  await expect(
    invokeControlled(captureControl(callControl(parent.signal)), callback),
  ).resolves.toEqual({ outcome: 'cancelled' });
  await expect(
    invokeControlled(
      captureControl({
        ...callControl(),
        deadlineAt: new Date(Date.now() - 1).toISOString(),
      }),
      callback,
    ),
  ).resolves.toEqual({ outcome: 'deadlineExceeded' });
  expect(callback).not.toHaveBeenCalled();
});

test('gives each invocation a separate signal and removes listeners and timers on success and failure', async () => {
  vi.useFakeTimers();
  const parent = new AbortController();
  const control = captureControl(callControl(parent.signal));
  const received: AbortSignal[] = [];
  for (const shouldFail of [false, true]) {
    const result = await invokeControlled(control, (current) => {
      received.push(current.signal);
      expect(current.signal).not.toBe(parent.signal);
      expect(current.deadlineAt).toBe(control.deadlineAt);
      if (shouldFail) throw new Error('callback failure');
      return Promise.resolve(7);
    });
    expect(result.outcome).toBe(shouldFail ? 'failed' : 'returned');
    expect(getEventListeners(parent.signal, 'abort')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  }
  expect(received[0]).not.toBe(received[1]);
});

test('ends waiting on cancellation and consumes a late rejection from an uncooperative adapter', async () => {
  vi.useFakeTimers();
  const parent = new AbortController();
  let reject!: (reason: unknown) => void;
  let signal: AbortSignal | undefined;
  const result = invokeControlled(
    captureControl(callControl(parent.signal)),
    (current) => {
      signal = current.signal;
      return new Promise<never>((_resolve, rejectPromise) => {
        reject = rejectPromise;
      });
    },
  );
  parent.abort();
  await expect(result).resolves.toEqual({ outcome: 'cancelled' });
  expect(signal?.aborted).toBe(true);
  expect(getEventListeners(parent.signal, 'abort')).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
  reject(new Error('late adapter rejection'));
  await Promise.resolve();
});

test('rejects results that reach the acceptance boundary at or after the deadline', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-02T00:00:00.000Z'));
  const control = captureControl(callControl());
  const result = invokeControlled(control, () => {
    vi.setSystemTime(new Date(control.deadlineMs));
    return Promise.resolve('late');
  });
  await expect(result).resolves.toEqual({ outcome: 'deadlineExceeded' });
  expect(vi.getTimerCount()).toBe(0);
});

test('waits for long deadlines without Node timer overflow', async () => {
  vi.useFakeTimers();
  const parent = new AbortController();
  const result = invokeControlled(
    captureControl({
      signal: parent.signal,
      deadlineAt: new Date(Date.now() + 2_147_483_648).toISOString(),
    }),
    () => new Promise<never>(() => {}),
  );
  let settled = false;
  void result.then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(1);
  expect(settled).toBe(false);
  parent.abort();
  await expect(result).resolves.toEqual({ outcome: 'cancelled' });
  expect(vi.getTimerCount()).toBe(0);
});

test('reports generation timeout with unknown provider counts and does not normalize late answers', async () => {
  vi.useFakeTimers();
  let resolve!: (value: ReturnType<typeof candidateSet>) => void;
  const generate = vi.fn<
    (
      request: CandidateRequest,
      control: CallControl,
    ) => Promise<ReturnType<typeof candidateSet>>
  >(
    () =>
      new Promise<ReturnType<typeof candidateSet>>((done) => {
        resolve = done;
      }),
  );
  const refinement = vi.fn(() => true);
  const registry = actionRegistry(
    z.object({ target: z.string().refine(refinement) }),
  );
  const control = {
    ...callControl(),
    deadlineAt: new Date(Date.now() + 20).toISOString(),
  };
  const result = prepareCandidates(
    generationInput(),
    registry,
    { generate },
    control,
  );
  await vi.advanceTimersByTimeAsync(20);
  await expect(result).resolves.toMatchObject({
    outcome: 'deadlineExceeded',
    stage: 'generation',
    report: { received: null, remaining: null },
  });
  expect(generate.mock.calls[0]?.[1].signal.aborted).toBe(true);
  resolve(
    candidateSet(generate.mock.calls[0]![0], [
      { id: 'late', params: { target: 'north' } },
    ]),
  );
  await Promise.resolve();
  expect(refinement).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test('stops a pending schema without starting later candidates and retains preparation progress', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const refinement = vi.fn(async (target: string) => {
    if (target === 'wait') await gate;
    return true;
  });
  const registry = actionRegistry(
    z.object({ target: z.string().refine(refinement) }),
  );
  const generate = (request: CandidateRequest) =>
    Promise.resolve(
      candidateSet(request, [
        { id: 'first', params: { target: 'north' } },
        { id: 'waiting', params: { target: 'wait' } },
        { id: 'last', params: { target: 'south' } },
      ]),
    );
  const control = {
    ...callControl(),
    deadlineAt: new Date(Date.now() + 20).toISOString(),
  };
  const result = prepareCandidates(
    generationInput(),
    registry,
    { generate },
    control,
  );
  await vi.advanceTimersByTimeAsync(20);
  await expect(result).resolves.toMatchObject({
    outcome: 'deadlineExceeded',
    stage: 'preparation',
    candidateId: 'waiting',
    report: { received: 3, normalized: 1, remaining: 2 },
  });
  expect(refinement).toHaveBeenCalledTimes(2);
  release();
  await Promise.resolve();
  expect(refinement).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});
