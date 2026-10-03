import { expect, test, vi } from 'vitest';
import { generationInput } from '#internal/candidate/__tests__/fixtures';
import { MemoryRunStore } from '#internal/storage/memory';
import { createAgent } from './agent.js';
import { RunSession } from './session.js';
import { invokeModel } from './model.js';
import { runnerFixture } from './__tests__/runner-fixtures.js';
import { parseRuntimeCheckpoint } from './checkpoint.js';

test('round-trips a completed runtime with fixed execution basis and application identity', async () => {
  const fixture = runnerFixture();
  const agent = createAgent({ ...fixture.options, applicationId: 'test-app' });
  const handle = await agent.start(fixture.input);
  await handle.result;
  const checkpoint = (await agent.inspect(handle.runId))!.checkpoint;
  const decoded = parseRuntimeCheckpoint(
    JSON.parse(JSON.stringify(checkpoint)),
  );
  expect(decoded.state.identity).toMatchObject({
    applicationId: 'test-app',
    actionVersions: [{ id: 'collect', version: 1 }],
  });
  expect(decoded.state.actionAttempts).toBe(2);
  expect(decoded.state.execution?.intent.params).toEqual({
    count: 1,
    target: 'north',
  });
  expect(decoded.state.execution?.basis.context.graph.runId).toBe(handle.runId);
  expect(Object.isFrozen(decoded.state.identity.actionVersions)).toBe(true);
  expect(
    Object.isFrozen(decoded.state.execution?.basis.context.graph.goals),
  ).toBe(true);
  await agent.close();
});

test('keeps an in-flight model reservation in its committed checkpoint', async () => {
  const session = await RunSession.create(
    new MemoryRunStore(),
    generationInput(),
    vi.fn(),
  );
  await session.transition({ kind: 'start' });
  let finish!: (value: { value: string; usage: null }) => void;
  const called = vi.fn(
    () =>
      new Promise<{ value: string; usage: null }>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = invokeModel(
    session,
    { requestId: 'model-1', decisionEpoch: 3, purpose: 'planning' },
    {
      signal: session.signal,
      deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    },
    called,
  );
  await vi.waitFor(() => expect(called).toHaveBeenCalledTimes(1));
  const state = parseRuntimeCheckpoint(session.checkpoint).state;
  expect(state.modelAttempts).toBe(1);
  expect(state.pendingModels).toEqual([
    {
      requestId: 'model-1',
      decisionEpoch: 3,
      purpose: 'planning',
      attempt: 1,
      phase: 'dispatched',
    },
  ]);
  finish({ value: 'plan', usage: null });
  await pending;
  expect(
    parseRuntimeCheckpoint(session.checkpoint).state.pendingModels,
  ).toEqual([]);
});

test.each([
  'version',
  'status',
  'parent',
  'path',
  'budget',
  'unknownField',
  'function',
])('rejects corrupt or unsupported continuation: %s', async (kind) => {
  const session = await RunSession.create(
    new MemoryRunStore(),
    generationInput(),
    vi.fn(),
  );
  const checkpoint = session.checkpoint!;
  const state = session.state;
  const graph = state.decision.context.graph;
  const changedGraph =
    kind === 'path'
      ? { ...graph, goalPath: [] }
      : {
          ...graph,
          goals: graph.goals.map((goal, index) =>
            index === 1
              ? { ...goal, parentGoalRef: { id: 'missing', version: 1 } }
              : goal,
          ),
        };
  const changedState =
    kind === 'budget'
      ? { ...state, modelAttempts: -1 }
      : kind === 'unknownField'
        ? { ...state, extra: 1 }
        : kind === 'function'
          ? { ...state, callback: () => {} }
          : {
              ...state,
              decision: {
                ...state.decision,
                context: { ...state.decision.context, graph: changedGraph },
              },
            };
  const input =
    kind === 'version'
      ? { ...checkpoint, stateSchemaVersion: 1 }
      : kind === 'status'
        ? { ...checkpoint, status: 'failed' }
        : { ...checkpoint, state: changedState };
  expect(() => parseRuntimeCheckpoint(input)).toThrow();
});
