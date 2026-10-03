import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import { defineAction } from '#internal/action/registry';
import type { ActionDefinition } from '#internal/contracts/action';
import type { ActionResult, RunStatus } from '#internal/contracts/record';
import { generationInput } from '#internal/candidate/__tests__/fixtures';
import { MemoryRunStore } from '#internal/storage/memory';
import { parseGoalGraph } from '#internal/validation/goal';
import { createAgent } from './agent.js';
import { RunSession } from './session.js';
import { parseRuntimeCheckpoint } from './checkpoint.js';
import { proposalBasis, runnerFixture } from './__tests__/runner-fixtures.js';

const parameters = z.strictObject({
  target: z.string(),
  count: z.number().default(1),
});

// Seed persisted boundaries independently of the new agent's live callback objects.
async function storedExecution(
  status: RunStatus = 'running',
  phase: 'prepared' | 'running' | 'succeeded' = 'prepared',
  retryMode: 'never' | 'idempotent' | 'reconcile' = 'reconcile',
) {
  const h = runnerFixture(0, 1);
  const source = generationInput(1, 1);
  const basis = {
    ...source,
    context: {
      ...source.context,
      graph: parseGoalGraph({
        runId: 'run',
        rootGoalRef: source.context.graph.rootGoalRef,
        currentGoalRef: source.context.graph.currentGoalRef,
        goals: source.context.graph.goals.map((goal) => ({
          ...goal,
          criteria: { count: 1 },
        })),
      }),
      observation: { ...source.context.observation, revision: 0 },
    },
  };
  const session = await RunSession.create(
    h.store,
    basis,
    vi.fn(),
    { actionRetries: 1 },
    {
      applicationId: 'recovery-fixture',
      actionVersions: [{ id: 'collect', version: 1 }],
      modelStages: [],
    },
  );
  const intent = {
    executionId: 'previous-execution',
    decisionId: 'decision',
    candidateSetId: 'set',
    candidateId: 'candidate',
    actionId: 'collect',
    actionVersion: 1,
    params: { target: 'north', count: 7 },
    rootGoalRef: basis.context.graph.rootGoalRef,
    currentGoalRef: basis.context.graph.currentGoalRef,
    goalPathRef: 'path',
    planRef: basis.context.planRef!,
    observationRef: {
      id: basis.context.observation.id,
      revision: basis.context.observation.revision,
    },
    constraintsVersion: basis.context.constraintsVersion,
  };
  const result: ActionResult | null =
    phase === 'succeeded'
      ? {
          executionId: intent.executionId,
          outcome: 'succeeded',
          reasonCode: 'done',
          underlyingSettled: true,
          confirmedEffects: { count: 1 },
          unresolvedEffects: {},
          progress: {},
          stopCauseEventId: null,
        }
      : null;
  const cause = { eventId: 'stop', reasonCode: 'user_stop' };
  await session.commit(
    {
      ...session.state,
      control: {
        ...session.state.control,
        status,
        stopCause: status === 'running' ? null : cause,
      },
      actionAttempts: 1,
      execution: {
        basis,
        retryMode,
        intent,
        decisionEpoch: basis.decisionEpoch,
        phase,
        result,
        retries: 0,
        reconciliation: null,
      },
      progressAttempt:
        result === null
          ? null
          : {
              executionId: intent.executionId,
              before: basis.context.graph,
              failed: false,
            },
      recentResults: result === null ? [] : [result],
      decision: {
        ...basis,
        context: { ...basis.context, lastActionResult: result },
      },
    },
    [
      {
        formatVersion: 1,
        runId: 'run',
        eventId: 'intent',
        kind: 'actionIntent',
        data: intent,
      },
      ...(result === null
        ? []
        : [
            {
              formatVersion: 1 as const,
              runId: 'run',
              eventId: 'result',
              kind: 'actionResult' as const,
              data: result,
            },
          ]),
    ],
  );
  // This test store has no external work. Release the seed writer at the chosen boundary.
  await h.store.close();
  await session.close();
  const memory = new MemoryRunStore();
  const snapshot = session.checkpoint!;
  const lease = await memory.acquireRun('run');
  await memory.commit({
    ownerToken: lease.token,
    runId: 'run',
    expectedRevision: null,
    status,
    rootGoalRef: basis.context.graph.rootGoalRef,
    currentGoalRef: basis.context.graph.currentGoalRef,
    stateSchemaVersion: snapshot.stateSchemaVersion,
    state: snapshot.state,
    records: [
      {
        formatVersion: 1,
        runId: 'run',
        eventId: 'intent',
        kind: 'actionIntent',
        data: intent,
      },
      ...(result === null
        ? []
        : [
            {
              formatVersion: 1 as const,
              runId: 'run',
              eventId: 'result',
              kind: 'actionResult' as const,
              data: result,
            },
          ]),
    ],
  });
  await lease.release();
  const reconcile = vi.fn<
    NonNullable<ActionDefinition<typeof parameters>['reconcile']>
  >((intent) =>
    Promise.resolve({
      outcome: 'performed',
      underlyingSettled: true,
      result: {
        executionId: intent.executionId,
        outcome: 'succeeded',
        reasonCode: 'confirmed',
        underlyingSettled: true,
        confirmedEffects: { count: 1 },
        unresolvedEffects: {},
        progress: {},
        stopCauseEventId: null,
      },
    }),
  );
  const action = defineAction({
    id: 'collect',
    version: 1,
    description: 'Collect',
    tags: [],
    expectedEffects: {},
    parameters,
    retryMode,
    check: () => Promise.resolve({ outcome: 'allowed' }),
    execute: h.execute,
    reconcile,
  });
  const options = {
    ...h.options,
    store: memory,
    actions: [action],
    applicationId: 'recovery-fixture',
  };
  return {
    ...h,
    store: memory,
    intent,
    reconcile,
    options,
    create: () => createAgent(options),
  };
}

test('resumes a deep run in a new instance with its saved limits, path and sibling order', async () => {
  const h = runnerFixture(0, 3);
  h.plan.mockImplementationOnce((request) =>
    Promise.resolve({
      ...proposalBasis(request),
      outcome: 'decompose',
      guidance: 'Finish both branches',
      nextTempId: 'leaf',
      goals: [
        {
          tempId: 'area',
          parent: {
            kind: 'accepted',
            goalRef: request.context.graph.rootGoalRef,
          },
          description: 'Area',
          criteria: { count: 3 },
        },
        {
          tempId: 'leaf',
          parent: { kind: 'proposed', tempId: 'area' },
          description: 'Leaf',
          criteria: { count: 2 },
        },
        {
          tempId: 'sibling',
          parent: { kind: 'proposed', tempId: 'area' },
          description: 'Sibling',
          criteria: { count: 3 },
        },
      ],
    }),
  );
  const options = {
    ...h.options,
    applicationId: 'deep',
    limits: { maxActionAttempts: 1 },
    modelStages: ['planning', 'selection'] as const,
  };
  const first = createAgent(options);
  await (
    await first.start(h.input)
  ).result;
  const before = parseRuntimeCheckpoint(
    (await first.inspect('run'))!.checkpoint,
  ).state;
  expect(before.decision.context.graph.goalPath).toHaveLength(3);
  await first.close();
  const second = createAgent({
    ...options,
    limits: { maxActionAttempts: 100 },
  });
  const stillLimited = await second.resume('run');
  expect((await stillLimited.result).blocker?.reasonCode).toBe(
    'action_budget_exhausted',
  );
  const restored = parseRuntimeCheckpoint(
    (await second.inspect('run'))!.checkpoint,
  ).state;
  expect(restored.decision.context.graph.goalPath).toEqual(
    before.decision.context.graph.goalPath,
  );
  expect(restored.goals).toEqual(before.goals);
  expect(restored.limits.maxActionAttempts).toBe(1);
  expect(restored.actionAttempts).toBe(1);
  await expect(
    (await second.resume('run', { limits: { maxActionAttempts: 3 } })).result,
  ).resolves.toMatchObject({ status: 'succeeded' });
  expect(h.execute).toHaveBeenCalledTimes(3);
  expect(h.plan).toHaveBeenCalledTimes(1);
  await second.close();
});

test.each(['prepared', 'running'] as const)(
  'reconciles a %s intent without reapplying defaults or executing it',
  async (phase) => {
    const h = await storedExecution('running', phase);
    const defaults = vi.fn(() => 99);
    const execute = vi.fn(h.execute);
    const action = defineAction({
      id: 'collect',
      version: 1,
      description: 'Reloaded',
      tags: [],
      expectedEffects: {},
      parameters: z.strictObject({
        target: z.string(),
        count: z.number().default(defaults),
      }),
      retryMode: 'reconcile',
      check: () => Promise.resolve({ outcome: 'allowed' }),
      execute,
      reconcile: h.reconcile,
    });
    defaults.mockClear();
    const agent = createAgent({ ...h.options, actions: [action] });
    await expect(agent.reconcile('run')).resolves.toMatchObject({
      outcome: 'performed',
    });
    expect(h.reconcile.mock.calls[0]![0]).toEqual(h.intent);
    expect(Object.isFrozen(h.reconcile.mock.calls[0]![0].params)).toBe(true);
    expect(defaults).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    const state = parseRuntimeCheckpoint(
      (await agent.inspect('run'))!.checkpoint,
    ).state;
    expect(state.control.status).toBe('paused');
    expect(state.actionAttempts).toBe(1);
    expect(state.execution?.result?.outcome).toBe('succeeded');
    expect(state.progressAttempt?.executionId).toBe(h.intent.executionId);
    await agent.close();
  },
);

test.each(['unknown', 'missing', 'invalid'] as const)(
  'keeps %s reconciliation paused and blocks all dispatch',
  async (mode) => {
    const h = await storedExecution();
    if (mode === 'invalid')
      h.reconcile.mockResolvedValue({
        outcome: 'notPerformed',
        // @ts-expect-error Exercise a callback that violates the settlement contract.
        underlyingSettled: false,
        reason: 'not_confirmed',
      });
    else
      h.reconcile.mockResolvedValue({
        outcome: 'unknown',
        reason: 'not_confirmed',
      });
    const actions =
      mode === 'missing'
        ? [
            defineAction({
              id: 'collect',
              version: 1,
              description: 'Unavailable',
              tags: [],
              expectedEffects: {},
              parameters,
              check: () => Promise.resolve({ outcome: 'allowed' }),
              execute: h.execute,
            }),
          ]
        : h.options.actions;
    const agent = createAgent({ ...h.options, actions });
    await expect(agent.resume('run')).rejects.toMatchObject({
      reason: 'execution_unsettled',
    });
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.plan).not.toHaveBeenCalled();
    expect((await agent.inspect('run'))!.summary.status).toBe('paused');
    await h.store.close();
  },
);

test.each(['cancelling', 'cancelled'] as const)(
  'retains %s intent while permitting cleanup only',
  async (status) => {
    const h = await storedExecution(status);
    const agent = h.create();
    await expect(agent.reconcile('run')).resolves.toMatchObject({
      outcome: 'performed',
    });
    expect((await agent.inspect('run'))!.summary.status).toBe('cancelled');
    await expect(agent.resume('run')).rejects.toMatchObject({
      reason: 'resume_unavailable',
    });
    expect(h.execute).not.toHaveBeenCalled();
    await agent.close();
  },
);

test('uses a committed result for verification without replaying execute or reconciliation', async () => {
  const h = await storedExecution('running', 'succeeded');
  const observation = generationInput().context.observation;
  h.observe.mockImplementation(() =>
    Promise.resolve({
      ...observation,
      revision: 100,
      data: { count: { status: 'known', value: 100 } },
    }),
  );
  const agent = h.create();
  await expect((await agent.resume('run')).result).resolves.toMatchObject({
    status: 'succeeded',
  });
  expect(h.execute).not.toHaveBeenCalled();
  expect(h.reconcile).not.toHaveBeenCalled();
  expect(h.verify).toHaveBeenCalled();
  await agent.close();
});

test('validates the checkpoint again after acquisition and releases a rejected lease', async () => {
  const h = await storedExecution();
  const read = h.store.readRun.bind(h.store);
  const before = await read('run');
  vi.spyOn(h.store, 'readRun')
    .mockResolvedValueOnce(before)
    .mockResolvedValueOnce({
      ...before!,
      checkpoint: { ...before!.checkpoint, stateSchemaVersion: 999 },
    });
  const agent = h.create();
  await expect(agent.resume('run')).rejects.toMatchObject({
    reason: 'unsupported_state_version',
  });
  const next = await h.store.acquireRun('run');
  await next.release();
  expect(await read('run')).toEqual(before);
  await agent.close();
});

test('rejects competing restores and close while ownership is pending', async () => {
  const h = await storedExecution();
  const acquire = h.store.acquireRun.bind(h.store);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.spyOn(h.store, 'acquireRun').mockImplementation(async (runId) => {
    entered();
    await gate;
    return acquire(runId);
  });
  const agent = h.create();
  const pending = agent.reconcile('run');
  await started;
  await expect(agent.reconcile('run')).rejects.toMatchObject({
    reason: 'run_owned',
  });
  await expect(agent.close()).rejects.toMatchObject({ reason: 'agent_active' });
  release();
  await pending;
  await agent.close();
});

test.each(['succeeded', 'failed'] as const)(
  'leaves a terminal %s run unchanged',
  async (status) => {
    const h = await storedExecution(status, 'succeeded');
    const before = await h.store.readRun('run');
    const acquire = vi.spyOn(h.store, 'acquireRun');
    const agent = h.create();
    await expect(agent.resume('run')).rejects.toMatchObject({
      reason: 'terminal_run',
    });
    expect(acquire).not.toHaveBeenCalled();
    expect(await h.store.readRun('run')).toEqual(before);
    await agent.close();
  },
);

test.each(['never', 'reconcile', 'idempotent'] as const)(
  'respects the saved %s retry policy after confirmed notPerformed',
  async (retryMode) => {
    const h = await storedExecution('running', 'prepared', retryMode);
    h.reconcile.mockResolvedValue({
      outcome: 'notPerformed',
      underlyingSettled: true,
      reason: 'no_effect',
    });
    // The next selection must reproduce the committed normalized parameters.
    const generate = h.generate.getMockImplementation()!;
    h.generate.mockImplementation(async (request, control) => {
      const set = await generate(request, control);
      return {
        ...set,
        candidates: set.candidates.map((candidate) => ({
          ...candidate,
          params: { target: 'north', count: 7 },
          paramSources: {
            ...candidate.paramSources,
            count: { kind: 'application', reference: 'retry:count' },
          },
        })),
      };
    });
    const agent = h.create();
    const result = await (await agent.resume('run')).result;
    if (retryMode === 'never') {
      expect(result).toMatchObject({
        status: 'paused',
        blocker: { reasonCode: 'retry_not_allowed' },
      });
      expect(h.execute).not.toHaveBeenCalled();
    } else {
      expect(h.execute).toHaveBeenCalledTimes(1);
      const records = (await agent.records('run', null, 1000)).records;
      expect(
        records.find(
          (r) => r.kind === 'coreEvent' && r.data.type === 'action_dispatched',
        ),
      ).toMatchObject({ data: { details: { retryOf: h.intent.executionId } } });
      expect(
        parseRuntimeCheckpoint((await agent.inspect('run'))!.checkpoint).state
          .actionAttempts,
      ).toBe(2);
    }
    await agent.close();
  },
);

test.each([
  'applicationId',
  'actionVersions',
  'modelStages',
  'version',
  'history',
] as const)(
  'rejects incompatible %s before acquiring or mutating a run',
  async (field) => {
    const h = await storedExecution();
    const read = h.store.readRun.bind(h.store);
    const before = await read('run');
    const acquire = vi.spyOn(h.store, 'acquireRun');
    if (field === 'version' || field === 'history')
      vi.spyOn(h.store, 'readRun').mockImplementation(async (runId) => {
        const stored = (await read(runId))!;
        return {
          ...stored,
          checkpoint: {
            ...stored.checkpoint,
            ...(field === 'version'
              ? { stateSchemaVersion: 999 }
              : { committedSequence: 999 }),
          },
        };
      });
    const agent = createAgent({
      ...h.options,
      ...(field === 'applicationId' ? { applicationId: 'other' } : {}),
      ...(field === 'actionVersions' ? { actions: [] } : {}),
      ...(field === 'modelStages' ? { modelStages: ['planning'] } : {}),
    });
    await expect(agent.resume('run')).rejects.toThrow();
    expect(acquire).not.toHaveBeenCalled();
    expect(await read('run')).toEqual(before);
    expect(h.execute).not.toHaveBeenCalled();
    await agent.close();
  },
);
