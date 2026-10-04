import { afterEach, expect, test, vi } from 'vitest';
import { createAgent } from './agent.js';
import { ModelRequestError } from './model.js';
import { runnerFixture } from './__tests__/runner-fixtures.js';

afterEach(() => vi.useRealTimers());

test.each(['planning', 'selection'] as const)(
  'retains classified %s errors in the result, checkpoint and callback record',
  async (stage) => {
    for (const code of [
      'unauthorized',
      'invalid_request',
      'input_limit',
      'refused',
      'output_truncated',
      'invalid_response',
      'deadline_exceeded',
      'rate_limited',
      'unavailable',
      'request_failed',
    ] as const) {
      const h = runnerFixture();
      const invoke = stage === 'planning' ? h.plan : h.select;
      invoke.mockRejectedValue(new ModelRequestError(code));
      const agent = createAgent({
        ...h.options,
        modelStages: [stage],
        limits: { modelRetries: 0 },
      });
      const run = await agent.start(h.input);
      await expect(run.result).resolves.toMatchObject({
        status: 'paused',
        stopCause: { reasonCode: code },
        blocker: { reasonCode: code },
      });
      expect((await agent.inspect(run.runId))?.checkpoint.state).toMatchObject({
        modelAttempts: 1,
        control: { blocker: { reasonCode: code } },
      });
      const records = (await agent.records(run.runId, null, 1000)).records;
      expect(
        records.find(
          (record) =>
            record.kind === 'coreEvent' &&
            record.data.type === 'callback_finished' &&
            record.data.reasonCode === stage,
        ),
      ).toMatchObject({
        data: { details: { outcome: 'failed', reasonCode: code } },
      });
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(h.execute).not.toHaveBeenCalled();
      await agent.close();
    }
  },
);

test.each(['planning', 'selection'] as const)(
  'keeps one total deadline for %s and aborts an unfinished SDK call',
  async (stage) => {
    vi.useFakeTimers();
    const h = runnerFixture();
    const aborted = vi.fn();
    const invoke = stage === 'planning' ? h.plan : h.select;
    invoke.mockImplementation((_request, control) => {
      control.signal.addEventListener('abort', aborted, { once: true });
      return new Promise<never>(() => {});
    });
    const agent = createAgent({
      ...h.options,
      modelStages: [stage],
      limits: { modelTimeoutMs: 10 },
    });
    const run = await agent.start(h.input);
    await vi.advanceTimersByTimeAsync(10);
    await expect(run.result).resolves.toMatchObject({
      status: 'paused',
      blocker: { reasonCode: 'deadline_exceeded' },
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(aborted).toHaveBeenCalledTimes(1);
    expect(h.execute).not.toHaveBeenCalled();
    expect(
      (await agent.inspect(run.runId))?.checkpoint.state.pendingModels,
    ).toEqual([]);
    await agent.close();
  },
);

test.each(['pause', 'cancel'] as const)(
  'retains the first %s cause when the SDK rejects on abort',
  async (stop) => {
    vi.useFakeTimers();
    const h = runnerFixture();
    h.plan.mockImplementation(
      (_request, control) =>
        new Promise((_resolve, reject) => {
          control.signal.addEventListener(
            'abort',
            () => reject(new ModelRequestError('unauthorized')),
            { once: true },
          );
        }),
    );
    const agent = createAgent({ ...h.options, modelStages: ['planning'] });
    const run = await agent.start(h.input);
    await vi.advanceTimersByTimeAsync(0);
    await agent[stop](run.runId, 'application_stop');
    await expect(run.result).resolves.toMatchObject({
      status: stop === 'pause' ? 'paused' : 'cancelled',
      stopCause: { reasonCode: 'application_stop' },
    });
    const records = (await agent.records(run.runId, null, 1000)).records;
    expect(
      records.find(
        (record) =>
          record.kind === 'coreEvent' && record.data.type === 'model_finished',
      ),
    ).toMatchObject({ data: { reasonCode: 'application_stop' } });
    expect(h.plan).toHaveBeenCalledTimes(1);
    expect(h.execute).not.toHaveBeenCalled();
    await agent.close();
  },
);

test('cancellation during model backoff keeps the application cause and sends no retry', async () => {
  vi.useFakeTimers();
  const h = runnerFixture();
  h.plan.mockRejectedValue(new ModelRequestError('rate_limited', 10_000));
  const agent = createAgent({ ...h.options, modelStages: ['planning'] });
  const run = await agent.start(h.input);
  await vi.advanceTimersByTimeAsync(1_000);
  await agent.cancel(run.runId, 'stop_waiting');
  await expect(run.result).resolves.toMatchObject({
    status: 'cancelled',
    stopCause: { reasonCode: 'stop_waiting' },
  });
  expect(h.plan).toHaveBeenCalledTimes(1);
  expect((await agent.inspect(run.runId))?.checkpoint.state.modelAttempts).toBe(
    1,
  );
  expect(h.execute).not.toHaveBeenCalled();
  await agent.close();
});
