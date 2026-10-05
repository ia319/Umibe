import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { ActionRegistry, defineAction } from '#internal/action/registry';
import type {
  ActionDefinition,
  ActionExecutionContext,
} from '#internal/contracts/action';
import type { Environment } from '#internal/contracts/adapters';
import type { ActionResult } from '#internal/contracts/record';
import type { GoalAssessment } from '#internal/contracts/goal';
import { filterCandidates } from '#internal/candidate/filter';
import { selectCandidates } from '#internal/selector/select';
import {
  callControl,
  checkedBatch,
  generationInput,
} from '#internal/candidate/__tests__/fixtures';
import { MemoryRunStore } from '#internal/storage/memory';
import { ActionCoordinator } from './execution.js';
import { RunSession } from './session.js';
import { invokeModel } from './model.js';
import type { RuntimeLimits } from './limits.js';

const parameters = z.strictObject({
  target: z.string(),
  count: z.number().default(1),
});
type Definition = ActionDefinition<typeof parameters>;
const cancelCause = { eventId: 'cancel', reasonCode: 'user_cancelled' };
afterEach(() => vi.useRealTimers());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function actionResult(
  executionId: string,
  changes: Partial<ActionResult> = {},
): ActionResult {
  return {
    executionId,
    outcome: 'succeeded',
    reasonCode: 'collected',
    underlyingSettled: true,
    confirmedEffects: { samples: 1 },
    unresolvedEffects: {},
    progress: {},
    stopCauseEventId: null,
    ...changes,
  };
}

async function select(registry: ActionRegistry) {
  const filtering = await filterCandidates(
    await checkedBatch(registry, ['north']),
    callControl(),
  );
  if (filtering.outcome !== 'filtered')
    throw new Error('Fixture filtering failed');
  const selected = await selectCandidates(
    filtering.filtered,
    {
      select: (request) =>
        Promise.resolve({
          outcome: 'selected',
          decisionId: 'decision',
          candidateSetId: request.candidates.id,
          candidateId: request.candidates.candidates[0]!.id,
        }),
    },
    callControl(),
  );
  if (selected.outcome !== 'selected')
    throw new Error('Fixture selection failed');
  return selected;
}

async function harness(
  action: Partial<Definition> = {},
  limits: Partial<RuntimeLimits> = {},
) {
  const check = vi.fn<Definition['check']>(() =>
    Promise.resolve({ outcome: 'allowed' }),
  );
  const execute = vi.fn<Definition['execute']>((_params, context) =>
    Promise.resolve(actionResult(context.executionId)),
  );
  const registry = new ActionRegistry([
    defineAction({
      id: 'collect',
      version: 1,
      description: 'Collect samples',
      tags: [],
      expectedEffects: { samples: 1 },
      parameters,
      check,
      execute,
      ...action,
    }),
  ]);
  const selected = await select(registry);
  const store = new MemoryRunStore();
  const diagnose = vi.fn();
  const session = await RunSession.create(
    store,
    generationInput(),
    diagnose,
    limits,
  );
  await session.transition({ kind: 'start' });
  const observe = vi.fn<Environment['observe']>((context) =>
    Promise.resolve({
      ...(context ?? session.state.decision.context).observation,
      revision:
        (context ?? session.state.decision.context).observation.revision + 1,
    }),
  );
  const coordinator = new ActionCoordinator(session, registry, { observe });
  return {
    store,
    session,
    registry,
    selected,
    coordinator,
    check,
    execute,
    observe,
    diagnose,
  };
}

test('commits intent before executing the selected fixed call and records effects without completing the goal', async () => {
  const h = await harness();
  h.execute.mockImplementation(async (params, context) => {
    expect(h.session.checkpoint?.state.actionAttempts).toBe(1);
    const records = (await h.store.readRecords('run', null, 100)).records;
    expect(
      records.find((record) => record.kind === 'actionIntent')?.data,
    ).toMatchObject({
      executionId: context.executionId,
      decisionId: 'decision',
      params: { target: 'north', count: 1 },
      observationRef: { revision: 5 },
    });
    expect(params).toBe(h.selected.candidate.params);
    expect(context.decision.effectiveConstraints).toEqual({
      maxCount: 2,
      protected: ['south'],
    });
    context.reportProgress({ collected: 1 });
    return actionResult(context.executionId);
  });
  await expect(h.coordinator.execute(h.selected)).resolves.toMatchObject({
    outcome: 'recorded',
    result: { outcome: 'succeeded' },
  });
  expect(h.check).toHaveBeenCalledTimes(2);
  expect(h.observe).toHaveBeenCalledTimes(2);
  expect(
    h.session.state.decision.context.lastActionResult?.confirmedEffects,
  ).toEqual({ samples: 1 });
  expect(h.session.state.control.status).toBe('running');
  expect(h.session.hasExecution).toBe(false);
  await expect(h.coordinator.execute(h.selected)).rejects.toMatchObject({
    reason: 'selection_already_used',
  });
});

test('rejects an earlier consumed selection after another selection executes', async () => {
  const h = await harness({ retryMode: 'never' }, { actionRetries: 1 });
  await h.coordinator.execute(h.selected);
  const next = await select(h.registry);
  await h.coordinator.execute(next);

  await expect(h.coordinator.execute(h.selected)).rejects.toMatchObject({
    reason: 'selection_already_used',
  });
  expect(h.execute).toHaveBeenCalledTimes(2);
  expect(h.session.state.actionAttempts).toBe(2);
});

test('rejects a consumed selection across coordinator instances', async () => {
  const h = await harness({ retryMode: 'never' }, { actionRetries: 1 });
  await h.coordinator.execute(h.selected);
  const other = new ActionCoordinator(h.session, h.registry, {
    observe: h.observe,
  });

  await expect(other.execute(h.selected)).rejects.toMatchObject({
    reason: 'selection_already_used',
  });
  expect(h.execute).toHaveBeenCalledTimes(1);
  expect(h.session.state.actionAttempts).toBe(1);
});

test('denies a fresh recheck without consuming the selection or charging an attempt', async () => {
  const h = await harness();
  h.check.mockImplementation((context) => {
    expect(context.observation.revision).toBe(5);
    return Promise.resolve({ outcome: 'denied', reason: 'target_gone' });
  });
  await expect(h.coordinator.execute(h.selected)).resolves.toMatchObject({
    outcome: 'notExecuted',
    reasonCode: 'denied',
  });
  expect(h.execute).not.toHaveBeenCalled();
  expect(h.session.state.actionAttempts).toBe(0);
  h.check.mockResolvedValue({ outcome: 'allowed' });
  await expect(h.coordinator.execute(h.selected)).resolves.toMatchObject({
    outcome: 'recorded',
  });
  expect(h.execute).toHaveBeenCalledTimes(1);
  expect(h.session.state.actionAttempts).toBe(1);
});

test.each(['cancel', 'ancestor'] as const)(
  'rejects %s changes admitted while intent persistence waits',
  async (change) => {
    const h = await harness();
    const gate = deferred<void>();
    const entered = deferred<void>();
    const original = h.store.commit.bind(h.store);
    vi.spyOn(h.store, 'commit').mockImplementation(async (input) => {
      if (input.records.some((record) => record.kind === 'actionIntent')) {
        entered.resolve();
        await gate.promise;
      }
      return original(input);
    });
    const pending = h.coordinator.execute(h.selected);
    await entered.promise;
    const changed =
      change === 'cancel'
        ? h.session.transition({ kind: 'cancel', cause: cancelCause })
        : h.session.replaceDecision(generationInput(2));
    gate.resolve();
    await changed;
    await expect(pending).resolves.toMatchObject({ outcome: 'notExecuted' });
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.session.state.actionAttempts).toBe(0);
    expect(h.session.state.execution?.result).toMatchObject({
      outcome: 'cancelled',
      underlyingSettled: true,
    });
    expect(h.session.hasExecution).toBe(false);
  },
);

test('rechecks cancellation admitted by the committed-intent subscriber', async () => {
  const h = await harness();
  h.session.subscribe((record) => {
    if (record.kind === 'actionIntent')
      void h.session.transition({ kind: 'cancel', cause: cancelCause });
  });
  await expect(h.coordinator.execute(h.selected)).resolves.toMatchObject({
    outcome: 'notExecuted',
  });
  expect(h.execute).not.toHaveBeenCalled();
  await expect(h.session.result).resolves.toMatchObject({
    status: 'cancelled',
  });
});

test('claims execution before observation across coordinator instances and cancels a hanging observation', async () => {
  vi.useFakeTimers();
  const h = await harness();
  h.observe.mockImplementation(() => new Promise(() => undefined));
  const pending = h.coordinator.execute(h.selected);
  const other = new ActionCoordinator(h.session, h.registry, {
    observe: h.observe,
  });
  await expect(other.execute(h.selected)).rejects.toMatchObject({
    reason: 'execution_busy',
  });
  await h.session.transition({ kind: 'cancel', cause: cancelCause });
  await expect(pending).resolves.toMatchObject({ outcome: 'notExecuted' });
  expect(h.execute).not.toHaveBeenCalled();
  expect(h.session.hasExecution).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

test('retains the barrier after cancel grace and accepts a late result only for the cancelled execution', async () => {
  vi.useFakeTimers();
  const returned = deferred<ActionResult>();
  const h = await harness(
    { execute: () => returned.promise },
    { stopGraceMs: 5 },
  );
  const pending = h.coordinator.execute(h.selected);
  await vi.advanceTimersByTimeAsync(0);
  const executionId = h.session.state.execution!.intent.executionId;
  await h.session.transition({ kind: 'cancel', cause: cancelCause });
  await vi.advanceTimersByTimeAsync(5);
  await expect(pending).resolves.toMatchObject({
    result: {
      outcome: 'unknown',
      underlyingSettled: false,
      stopCauseEventId: 'cancel',
    },
  });
  await expect(h.session.result).resolves.toMatchObject({
    status: 'cancelled',
    blocker: { reasonCode: 'execution_unsettled' },
  });
  expect(h.session.hasExecution).toBe(true);
  await expect(h.session.close()).rejects.toThrow();
  returned.resolve(actionResult(executionId));
  await vi.advanceTimersByTimeAsync(0);
  expect(h.session.state.execution?.result).toMatchObject({
    executionId,
    outcome: 'succeeded',
    stopCauseEventId: 'cancel',
  });
  expect(h.session.state.control.status).toBe('cancelled');
  expect(h.session.hasExecution).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  await h.session.close();
});

test('times out with a recorded stop cause and forbids resume while the old execution remains uncertain', async () => {
  vi.useFakeTimers();
  const h = await harness(
    { execute: () => new Promise(() => undefined) },
    { actionTimeoutMs: 10, stopGraceMs: 5 },
  );
  const pending = h.coordinator.execute(h.selected);
  await vi.advanceTimersByTimeAsync(15);
  await expect(pending).resolves.toMatchObject({
    result: { outcome: 'unknown', reasonCode: 'action_timeout' },
  });
  await expect(h.session.result).resolves.toMatchObject({ status: 'paused' });
  await expect(h.session.transition({ kind: 'resume' })).rejects.toMatchObject({
    reason: 'execution_unsettled',
  });
  const records = (await h.store.readRecords('run', null, 100)).records;
  expect(
    records.some(
      (record) =>
        record.eventId === h.session.state.execution?.result?.stopCauseEventId,
    ),
  ).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

test('accepts cooperative abort within grace and preserves the first stop reason', async () => {
  vi.useFakeTimers();
  const h = await harness(
    {
      execute: (_params, context) =>
        new Promise((resolve) => {
          context.signal.addEventListener('abort', () =>
            resolve(
              actionResult(context.executionId, {
                outcome: 'cancelled',
                confirmedEffects: {},
              }),
            ),
          );
        }),
    },
    { stopGraceMs: 10 },
  );
  const pending = h.coordinator.execute(h.selected);
  await vi.advanceTimersByTimeAsync(0);
  const cause = { eventId: 'pause', reasonCode: 'user_paused' };
  await h.session.transition({ kind: 'pause', cause });
  await h.session.transition({ kind: 'cancel', cause: cancelCause });
  await expect(pending).resolves.toMatchObject({
    result: {
      outcome: 'cancelled',
      underlyingSettled: true,
      stopCauseEventId: 'pause',
    },
  });
  expect(h.session.state.control.status).toBe('cancelled');
  expect(h.session.hasExecution).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

test('treats an execution exception as unknown effects and never retries implicitly', async () => {
  const execute = vi.fn(() => {
    throw new Error('connection lost after write');
  });
  const h = await harness(
    { execute, retryMode: 'idempotent' },
    { actionRetries: 1 },
  );
  await expect(h.coordinator.execute(h.selected)).resolves.toMatchObject({
    result: { outcome: 'unknown', underlyingSettled: false },
  });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(h.session.hasExecution).toBe(true);
  expect(h.session.state.actionAttempts).toBe(1);
});

test.each(['throw', 'invalid', 'hang'] as const)(
  'preserves confirmed effects when result verification returns %s',
  async (mode) => {
    vi.useFakeTimers();
    const h = await harness(
      {
        verifyResult: () => {
          if (mode === 'throw') throw new Error('verification failed');
          if (mode === 'invalid') return Promise.resolve({} as ActionResult);
          return new Promise(() => undefined);
        },
      },
      { verificationTimeoutMs: 10 },
    );
    const pending = h.coordinator.execute(h.selected);
    await vi.advanceTimersByTimeAsync(10);
    await expect(pending).resolves.toMatchObject({
      result: {
        outcome: 'unknown',
        underlyingSettled: true,
        confirmedEffects: { samples: 1 },
      },
    });
    expect(h.session.state.control.blocker?.reasonCode).toBe('effects_unknown');
    expect(h.session.hasExecution).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  },
);

test('retains confirmed partial effects when the action reports an unsettled result', async () => {
  const h = await harness({
    execute: (_params, context) =>
      Promise.resolve(
        actionResult(context.executionId, {
          outcome: 'unknown',
          underlyingSettled: false,
          unresolvedEffects: { collector: 'running' },
        }),
      ),
  });
  await expect(h.coordinator.execute(h.selected)).resolves.toMatchObject({
    result: { confirmedEffects: { samples: 1 } },
  });
  expect(h.session.hasExecution).toBe(true);
  expect(h.session.state.control.blocker?.reasonCode).toBe(
    'execution_unsettled',
  );
});

test('reconciles before one explicitly allowed retry and ignores the old result after confirmed cleanup', async () => {
  vi.useFakeTimers();
  const old = deferred<ActionResult>();
  const execute = vi
    .fn<Definition['execute']>()
    .mockImplementationOnce(() => old.promise)
    .mockImplementation((_params, context) =>
      Promise.resolve(actionResult(context.executionId, { outcome: 'failed' })),
    );
  const reconcile = vi
    .fn<NonNullable<Definition['reconcile']>>()
    .mockResolvedValueOnce({ outcome: 'unknown', reason: 'not_yet_known' })
    .mockResolvedValue({
      outcome: 'notPerformed',
      underlyingSettled: true,
      reason: 'rollback_confirmed',
    });
  const h = await harness(
    { execute, reconcile, retryMode: 'reconcile' },
    { actionRetries: 1, actionTimeoutMs: 10, stopGraceMs: 5 },
  );
  const pending = h.coordinator.execute(h.selected);
  await vi.advanceTimersByTimeAsync(15);
  await pending;
  const oldId = h.session.state.execution!.intent.executionId;
  await expect(h.coordinator.reconcile(callControl())).resolves.toMatchObject({
    outcome: 'unknown',
  });
  expect(h.session.hasExecution).toBe(true);
  await expect(h.coordinator.reconcile(callControl())).resolves.toMatchObject({
    outcome: 'notPerformed',
  });
  expect(h.session.hasExecution).toBe(false);
  expect(h.session.state.control.status).toBe('paused');
  await h.session.transition({ kind: 'resume' });
  await expect(h.coordinator.execute(h.selected, oldId)).resolves.toMatchObject(
    { result: { outcome: 'failed' } },
  );
  const newId = h.session.state.execution!.intent.executionId;
  expect(newId).not.toBe(oldId);
  old.resolve(actionResult(oldId));
  await vi.advanceTimersByTimeAsync(0);
  expect(h.session.state.execution!.intent.executionId).toBe(newId);
  expect(h.session.state.decision.context.lastActionResult?.executionId).toBe(
    newId,
  );
  await expect(h.coordinator.execute(h.selected, newId)).rejects.toMatchObject({
    reason: 'retry_not_allowed',
  });
  expect(execute).toHaveBeenCalledTimes(2);
  expect(h.session.state.actionAttempts).toBe(2);
});

test('preserves retry lineage when a reserved retry is cancelled before dispatch', async () => {
  const h = await harness(
    {
      retryMode: 'reconcile',
      execute: () => Promise.reject(new Error('unconfirmed')),
      reconcile: () =>
        Promise.resolve({
          outcome: 'notPerformed',
          underlyingSettled: true,
          reason: 'confirmed_absent',
        }),
    },
    { actionRetries: 1 },
  );
  await h.coordinator.execute(h.selected);
  await h.coordinator.reconcile(callControl());
  await h.session.transition({ kind: 'resume' });
  const commit = h.store.commit.bind(h.store);
  let paused: Promise<void> | undefined;
  const writer = vi.spyOn(h.store, 'commit').mockImplementation((input) => {
    if (
      paused === undefined &&
      input.records.some((record) => record.kind === 'actionIntent')
    )
      paused = h.session.transition({ kind: 'pause', cause: cancelCause });
    return commit(input);
  });
  const oldId = h.session.state.execution!.intent.executionId;
  await expect(h.coordinator.execute(h.selected, oldId)).resolves.toMatchObject(
    { outcome: 'notExecuted' },
  );
  await paused;
  writer.mockRestore();
  expect(h.session.state.actionAttempts).toBe(1);
  await h.session.close();
  h.session = await RunSession.restore(h.store, 'run', h.diagnose, {
    applicationId: null,
    actionVersions: [],
    modelStages: [],
  });
  h.coordinator = new ActionCoordinator(h.session, h.registry, {
    observe: h.observe,
  });
  await h.session.transition({ kind: 'resume' });
  await h.coordinator.execute(await select(h.registry));
  await h.coordinator.reconcile(callControl());
  await h.session.transition({ kind: 'resume' });
  await expect(
    h.coordinator.execute(await select(h.registry)),
  ).rejects.toMatchObject({ reason: 'retry_not_allowed' });
  expect(h.session.state.actionAttempts).toBe(2);
});

test('creates an independent cancellation signal per execution and rejects stale interrupts', async () => {
  vi.useFakeTimers();
  const contexts: ActionExecutionContext[] = [];
  const h = await harness({
    execute: (_params, context) => {
      contexts.push(context);
      return new Promise((resolve) =>
        context.signal.addEventListener('abort', () =>
          resolve(actionResult(context.executionId, { outcome: 'cancelled' })),
        ),
      );
    },
  });
  const first = h.coordinator.execute(h.selected);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.coordinator.interrupt(contexts[0]!.executionId, cancelCause)).toBe(
    true,
  );
  await first;
  const next = await select(h.registry);
  const second = h.coordinator.execute(next);
  await vi.advanceTimersByTimeAsync(0);
  expect(contexts[0]!.signal).not.toBe(contexts[1]!.signal);
  expect(contexts[1]!.signal.aborted).toBe(false);
  expect(h.coordinator.interrupt(contexts[0]!.executionId, cancelCause)).toBe(
    false,
  );
  expect(contexts[1]!.signal.aborted).toBe(false);
  h.coordinator.interrupt(contexts[1]!.executionId, cancelCause);
  await second;
  expect(vi.getTimerCount()).toBe(0);
});

test('pauses on exhausted action budget before observation or execution', async () => {
  const h = await harness({}, { maxActionAttempts: 0 });
  await expect(h.coordinator.execute(h.selected)).resolves.toMatchObject({
    outcome: 'notExecuted',
    reasonCode: 'action_budget_exhausted',
  });
  expect(h.observe).not.toHaveBeenCalled();
  expect(h.execute).not.toHaveBeenCalled();
  expect(h.session.state.control.blocker?.reasonCode).toBe(
    'action_budget_exhausted',
  );
});

test('model budget exhaustion waits for the active execution stop boundary', async () => {
  vi.useFakeTimers();
  const h = await harness(
    {
      execute: (_params, context) =>
        new Promise((resolve) =>
          context.signal.addEventListener('abort', () =>
            resolve(
              actionResult(context.executionId, { outcome: 'cancelled' }),
            ),
          ),
        ),
    },
    { maxModelAttempts: 0 },
  );
  const pending = h.coordinator.execute(h.selected);
  await vi.advanceTimersByTimeAsync(0);
  await expect(
    invokeModel(
      h.session,
      { requestId: 'model', decisionEpoch: 3, purpose: 'planning' },
      callControl(),
      vi.fn(),
    ),
  ).resolves.toEqual({ outcome: 'budgetExceeded' });
  await pending;
  expect(h.session.state.control).toMatchObject({
    status: 'paused',
    blocker: { reasonCode: 'model_budget_exhausted' },
  });
  expect(h.session.hasExecution).toBe(false);
});

test.each(['observe', 'check'] as const)(
  'bounds a hanging %s callback before dispatch',
  async (callback) => {
    vi.useFakeTimers();
    const h = await harness({}, { callbackTimeoutMs: 10 });
    if (callback === 'observe')
      h.observe.mockImplementation(() => new Promise(() => undefined));
    else h.check.mockImplementation(() => new Promise(() => undefined));
    const pending = h.coordinator.execute(h.selected);
    await vi.advanceTimersByTimeAsync(10);
    await expect(pending).resolves.toMatchObject({ outcome: 'notExecuted' });
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.session.state.control.status).toBe('paused');
    expect(h.session.hasExecution).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  },
);

test('aborts execution on storage failure without requiring another writable commit', async () => {
  vi.useFakeTimers();
  let context!: ActionExecutionContext;
  const late = deferred<ActionResult>();
  const h = await harness(
    {
      execute: (_params, input) => {
        context = input;
        return late.promise;
      },
    },
    { stopGraceMs: 5 },
  );
  const original = h.store.commit.bind(h.store);
  vi.spyOn(h.store, 'commit').mockImplementation((input) => {
    if (
      input.records.some(
        (record) =>
          record.kind === 'coreEvent' &&
          record.data.type === 'action_dispatched',
      )
    )
      return Promise.reject(new Error('disk unavailable'));
    return original(input);
  });
  const pending = h.coordinator.execute(h.selected);
  const rejected = expect(pending).rejects.toThrow('disk unavailable');
  await vi.advanceTimersByTimeAsync(5);
  await rejected;
  expect(context.signal.aborted).toBe(true);
  expect(h.session.failure?.reason).toBe('store_failed');
  expect(h.diagnose).toHaveBeenCalledWith(
    expect.objectContaining({ code: 'store_failed' }),
  );
  expect(h.session.hasExecution).toBe(true);
  await expect(h.session.close()).rejects.toThrow();
  expect(vi.getTimerCount()).toBe(0);
  late.resolve(actionResult(context.executionId));
  await vi.advanceTimersByTimeAsync(0);
  expect(h.session.hasExecution).toBe(false);
  expect(h.session.failure?.reason).toBe('store_failed');
  await h.session.close();
});

test.each([
  { outcome: 'notPerformed', underlyingSettled: false, reason: 'not_visible' },
  {
    outcome: 'performed',
    underlyingSettled: true,
    result: actionResult('another-execution'),
  },
])('rejects unconfirmed or mismatched reconciliation: %j', async (value) => {
  const h = await harness({
    execute: () => {
      throw new Error('unknown outcome');
    },
    reconcile: () =>
      Promise.resolve(
        value as Awaited<ReturnType<NonNullable<Definition['reconcile']>>>,
      ),
  });
  await h.coordinator.execute(h.selected);
  await expect(h.coordinator.reconcile(callControl())).resolves.toEqual({
    outcome: 'unknown',
    reason: 'invalid_reconciliation',
  });
  expect(h.session.hasExecution).toBe(true);
});

test('discards reconciliation when a late execution result wins the race', async () => {
  vi.useFakeTimers();
  const late = deferred<ActionResult>();
  const cleanup =
    deferred<Awaited<ReturnType<NonNullable<Definition['reconcile']>>>>();
  const h = await harness(
    { execute: () => late.promise, reconcile: () => cleanup.promise },
    { actionTimeoutMs: 10, stopGraceMs: 5 },
  );
  const pending = h.coordinator.execute(h.selected);
  await vi.advanceTimersByTimeAsync(15);
  await pending;
  const reconciling = h.coordinator.reconcile(callControl());
  late.resolve(actionResult(h.session.state.execution!.intent.executionId));
  await vi.advanceTimersByTimeAsync(0);
  cleanup.resolve({
    outcome: 'notPerformed',
    underlyingSettled: true,
    reason: 'stale_read',
  });
  await expect(reconciling).resolves.toEqual({
    outcome: 'unknown',
    reason: 'execution_changed',
  });
  expect(h.session.state.execution?.result?.outcome).toBe('succeeded');
  expect(h.session.hasExecution).toBe(false);
});

test('keeps partial effects while grace expires during result verification', async () => {
  vi.useFakeTimers();
  const verified = deferred<ActionResult>();
  const h = await harness(
    { verifyResult: () => verified.promise },
    { actionTimeoutMs: 10, stopGraceMs: 5 },
  );
  const pending = h.coordinator.execute(h.selected);
  await vi.advanceTimersByTimeAsync(15);
  await expect(pending).resolves.toMatchObject({
    result: {
      outcome: 'unknown',
      underlyingSettled: true,
      confirmedEffects: { samples: 1 },
    },
  });
  verified.resolve(actionResult(h.session.state.execution!.intent.executionId));
  await vi.advanceTimersByTimeAsync(0);
  expect(h.session.state.control.status).toBe('paused');
  expect(h.session.hasExecution).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

test.each([{}, { actionRetries: 1 }] as const)(
  'enforces retry configuration and action policy: %j',
  async (limits) => {
    const h = await harness(
      {
        execute: (_params, context) =>
          Promise.resolve(
            actionResult(context.executionId, { outcome: 'failed' }),
          ),
      },
      limits,
    );
    await h.coordinator.execute(h.selected);
    await expect(
      h.coordinator.execute(
        h.selected,
        h.session.state.execution!.intent.executionId,
      ),
    ).rejects.toMatchObject({ reason: 'retry_not_allowed' });
  },
);

test('rejects timeout values that native timers would clamp', async () => {
  await expect(
    harness({}, { actionTimeoutMs: 2_147_483_648 }),
  ).rejects.toMatchObject({
    reason: 'invalid_limit',
    path: '/actionTimeoutMs',
  });
});

test('requires a fresh root assessment after execution and rejects success while an execution is held', async () => {
  const h = await harness();
  const observationRef = { id: 'observation', revision: 4 };
  const assessment = {
    goalRef: { id: 'root', version: 1 },
    observationRef,
    outcome: 'passed',
    reason: null,
    evidence: {
      source: 'application',
      observationPaths: ['/samples'],
      executionIds: [],
      details: {},
    },
  } satisfies GoalAssessment;
  const release = h.session.claimExecution();
  await expect(
    h.session.transition({ kind: 'succeed', assessment, observationRef }),
  ).rejects.toMatchObject({ reason: 'execution_unsettled' });
  release();
  await h.coordinator.execute(h.selected);
  await expect(
    h.session.transition({ kind: 'succeed', assessment, observationRef }),
  ).rejects.toMatchObject({ reason: 'stale_assessment' });
  const latest = h.session.state.decision.context.observation;
  const fresh = { id: latest.id, revision: latest.revision };
  await h.session.transition({
    kind: 'succeed',
    assessment: { ...assessment, observationRef: fresh },
    observationRef: fresh,
  });
  await expect(h.session.result).resolves.toMatchObject({
    status: 'succeeded',
  });
});
