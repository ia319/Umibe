import { expect, test, vi } from 'vitest';
import type { ChoiceHistoryEntry } from '#internal/contracts/choice-history';
import type {
  ChoiceRequest,
  StructuredOutputRequest,
} from '#internal/model/contracts';
import { createDecisionPolicy } from '#internal/decision/model';
import { createPlanner } from '#internal/planner/model';
import { createSelector } from '#internal/selector/model';
import { MemoryRunStore } from '#internal/storage/memory';
import {
  candidateSet,
  generationInput,
} from '#internal/candidate/__tests__/fixtures';
import type {
  SelectionResult,
  SelectorBatchRequest,
} from '#internal/selector/contracts';
import { readChoiceHistory } from '#internal/validation/choice-history';
import { createAgent } from './agent.js';
import { RunSession } from './session.js';
import { parseRuntimeCheckpoint } from './checkpoint.js';
import { ModelRequestError } from './model.js';
import {
  applicationEvent,
  fixtureDecisionPolicy,
  runnerFixture,
} from './__tests__/runner-fixtures.js';

test.each(['single', 'resumable'] as const)(
  'projects accepted choices to all model roles with a %s selector',
  async (kind) => {
    const h = runnerFixture(0, 2);
    const decisionMessages: ChoiceRequest[] = [];
    const selectionMessages: ChoiceRequest[] = [];
    const planningMessages: StructuredOutputRequest[] = [];
    let chosenId = '';
    const policy = createDecisionPolicy({
      model: {
        kind: 'choice',
        identity: { provider: 'fixture', model: 'decision' },
        choose(request) {
          decisionMessages.push(request);
          return Promise.resolve({ optionId: chosenId });
        },
      },
    });
    const agent = createAgent({
      ...h.options,
      planner: createPlanner({
        model: {
          kind: 'structuredOutput',
          identity: { provider: 'fixture', model: 'planning' },
          generate(request) {
            planningMessages.push(request);
            return Promise.resolve({
              proposal: {
                outcome: 'continue',
                nextGoalRef: { id: 'root', version: 1 },
                guidance: 'Collect samples',
                goalOrder: null,
              },
            });
          },
        },
      }),
      decisionPolicy: {
        async decide(request, control) {
          chosenId = (await fixtureDecisionPolicy.decide(request, control))
            .optionId;
          return policy.decide(request, control);
        },
      },
      selector: createSelector({
        overflow: kind === 'single' ? 'reject' : 'compareBatches',
        model: {
          kind: 'choice',
          identity: { provider: 'fixture', model: 'selection' },
          maxOptions: 3,
          choose(request) {
            selectionMessages.push(request);
            return Promise.resolve({ optionId: request.options[0]!.id });
          },
        },
      }),
    });
    try {
      const run = await agent.start(h.input);
      await expect(run.result).resolves.toMatchObject({ status: 'succeeded' });
      const candidate: unknown = expect.objectContaining({
        actionId: 'collect',
        params: { target: 'north', count: 1 },
      });
      const selected: unknown = expect.objectContaining({
        kind: 'selectionResult',
        comparisonComplete: true,
        operationId: 'collect',
        outcome: 'selected',
        candidate,
      });
      expect(decisionMessages[0]!.instructions).toHaveProperty(
        'references.recentChoices',
        [],
      );
      expect(decisionMessages.at(-1)!.instructions).toHaveProperty(
        'references.recentChoices',
        expect.arrayContaining([selected]),
      );
      expect(planningMessages[0]!.input).toHaveProperty(
        'context.recentChoices.0.choice.kind',
        'replan',
      );
      expect(selectionMessages).toHaveLength(2);
      expect(selectionMessages[0]!.instructions).toHaveProperty(
        'references.context.recentChoices',
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'selectionStarted',
            candidateCount: 1,
          }),
        ]),
      );
      expect(selectionMessages[1]!.instructions).toHaveProperty(
        'references.context.recentChoices',
        expect.arrayContaining([selected]),
      );
      const history = parseRuntimeCheckpoint(
        (await agent.inspect(run.runId))!.checkpoint,
      ).state.recentChoices;
      expect(
        history.filter((entry) => entry.kind === 'selectionResult'),
      ).toEqual([selected, selected]);
      expect(history.some((entry) => entry.kind === 'selectionDiscarded')).toBe(
        false,
      );
      expect(h.execute).toHaveBeenCalledTimes(2);
    } finally {
      await agent.close();
    }
  },
);

test('bounds history, restores it independently of live selection, and starts fresh runs empty', async () => {
  const store = new MemoryRunStore();
  const session = await RunSession.create(store, generationInput(), vi.fn());
  for (let i = 0; i < 25; i++) {
    await session.commit(
      session.state,
      [],
      [
        {
          kind: 'decision',
          recordedAt: new Date().toISOString(),
          goalRef: { id: 'collect', version: 1 },
          selectionId: null,
          choice: { id: `choice-${i}`, kind: 'wait' },
        },
      ],
    );
  }
  expect(session.state.recentChoices).toHaveLength(20);
  expect(session.state.recentChoices[0]).toMatchObject({
    choice: { id: 'choice-5' },
  });
  const identity = session.state.identity;
  const saved = session.state.recentChoices;
  await session.close();
  const restored = await RunSession.restore(store, 'run', vi.fn(), identity);
  expect(restored.state.recentChoices).toEqual(saved);
  expect(restored.state.decision.context.runtime?.recentChoices).toEqual(saved);
  expect(Object.isFrozen(restored.state.recentChoices[0])).toBe(true);
  await restored.close();
  const fresh = await RunSession.create(
    new MemoryRunStore(),
    generationInput(),
    vi.fn(),
  );
  expect(fresh.state.recentChoices).toEqual([]);
  await fresh.close();
});

test('preserves retry input and records an earlier batch winner when the final batch abstains', async () => {
  const h = runnerFixture(0, 1);
  const requests: SelectorBatchRequest[] = [];
  h.generate.mockImplementation((request) =>
    Promise.resolve(
      candidateSet(
        request,
        ['north', 'south', 'west'].map((target) => ({
          id: target,
          params: { target },
        })),
      ),
    ),
  );
  const agent = createAgent({
    ...h.options,
    limits: { modelRetries: 1 },
    selector: {
      kind: 'resumable',
      model: { provider: 'fixture', model: 'selection' },
      batchCapacity: 2,
      advance(request) {
        requests.push(request);
        if (requests.length === 1)
          return Promise.reject(new ModelRequestError('unavailable'));
        return Promise.resolve({
          decisionId: request.requestId,
          candidateSetId: request.candidates.id,
          ...(request.batchIndex === 0
            ? {
                outcome: 'selected' as const,
                candidateId: request.candidates.candidates[0]!.id,
              }
            : { outcome: 'abstain' as const, reason: 'no_better_call' }),
        });
      },
    },
  });
  try {
    const run = await agent.start(h.input);
    await expect(run.result).resolves.toMatchObject({ status: 'succeeded' });
    expect(requests).toHaveLength(3);
    expect(requests[0]).toBe(requests[1]);
    expect(
      requests[2]!.context.runtime!.recentChoices?.find(
        (entry) => entry.kind === 'selectionResult',
      ),
    ).toMatchObject({
      comparisonComplete: false,
      outcome: 'selected',
      candidate: { params: { target: 'north', count: 1 } },
    });
    const history = parseRuntimeCheckpoint(
      (await agent.inspect(run.runId))!.checkpoint,
    ).state.recentChoices.filter((entry) => entry.kind === 'selectionResult');
    expect(history).toHaveLength(2);
    expect(history[1]).toMatchObject({
      comparisonComplete: true,
      outcome: 'selected',
      candidate: { params: { target: 'north', count: 1 } },
    });
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.execute.mock.calls[0]![0]).toEqual({ target: 'north', count: 1 });
  } finally {
    await agent.close();
  }
});

test('rejects malformed choice evidence and detaches accepted parameter objects', () => {
  const context = {
    code: 'INVALID_RUN_CHECKPOINT',
    stage: 'history_test',
  } as const;
  const entry = {
    kind: 'selectionResult',
    recordedAt: '2026-10-18T04:00:00.000Z',
    goalRef: { id: 'goal', version: 1 },
    selectionId: 'selection',
    operationId: 'look',
    round: 0,
    batchIndex: 0,
    comparisonComplete: true,
    outcome: 'selected',
    candidate: { id: 'candidate', actionId: 'look', params: { yaw: 0 } },
    reasonCode: null,
  } satisfies ChoiceHistoryEntry;
  const captured = readChoiceHistory([entry], context, '/history');
  entry.candidate.params.yaw = 1;
  expect(captured[0]).toMatchObject({ candidate: { params: { yaw: 0 } } });
  expect(() =>
    readChoiceHistory([{ ...entry, candidate: null }], context, '/history'),
  ).toThrow();
  expect(() =>
    readChoiceHistory(
      [{ ...entry, candidate: { ...entry.candidate, actionId: 'dig' } }],
      context,
      '/history',
    ),
  ).toThrow();
  expect(() =>
    readChoiceHistory(
      Array.from({ length: 21 }, () => entry),
      context,
      '/history',
    ),
  ).toThrow();
});

test('does not report a rejected option as an accepted historical decision', async () => {
  const h = runnerFixture(0, 1);
  const agent = createAgent({
    ...h.options,
    decisionPolicy: {
      decide: () => Promise.resolve({ optionId: 'not-offered' }),
    },
  });
  try {
    const run = await agent.start(h.input);
    await expect(run.result).resolves.toMatchObject({ status: 'paused' });
    expect(
      (await agent.inspect(run.runId))!.checkpoint.state.recentChoices,
    ).toEqual([]);
    expect(h.execute).not.toHaveBeenCalled();
  } finally {
    await agent.close();
  }
});

test.each(['pause', 'cancel'] as const)(
  'retains one discard after %s interrupts a single-call selection',
  async (control) => {
    const h = runnerFixture(0, 1);
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    h.select.mockImplementationOnce(() => {
      enter();
      return new Promise(() => undefined);
    });
    const agent = h.create();
    try {
      const run = await agent.start(h.input);
      await entered;
      await agent[control](run.runId, `${control}_during_selection`);
      await expect(run.result).resolves.toMatchObject({
        status: control === 'pause' ? 'paused' : 'cancelled',
      });
      const state = parseRuntimeCheckpoint(
        (await agent.inspect(run.runId))!.checkpoint,
      ).state;
      const started = state.recentChoices.find(
        (entry) => entry.kind === 'selectionStarted',
      )!;
      expect(
        state.recentChoices.filter((entry) => entry.kind !== 'decision'),
      ).toEqual([
        started,
        expect.objectContaining({
          kind: 'selectionDiscarded',
          selectionId: started.selectionId,
          operationId: 'collect',
          goalRef: started.goalRef,
          reasonCode: `${control}_during_selection`,
          candidate: null,
        }),
      ]);
      expect(h.execute).not.toHaveBeenCalled();
      await agent.close();
      const restored = await RunSession.restore(
        h.store,
        run.runId,
        vi.fn(),
        state.identity,
      );
      try {
        expect(restored.state.recentChoices).toEqual(state.recentChoices);
        expect(restored.state.decision.context.runtime?.recentChoices).toEqual(
          state.recentChoices,
        );
      } finally {
        await restored.close();
      }
    } finally {
      await agent.close();
    }
  },
);

test('retains a discard when pause precedes single-call selector dispatch', async () => {
  const h = runnerFixture(0, 1);
  const agent = h.create();
  const pauses: Promise<void>[] = [];
  try {
    const run = await agent.start(h.input);
    agent.subscribe(run.runId, (record) => {
      if (
        record.kind === 'coreEvent' &&
        record.data.type === 'selection_started'
      )
        pauses.push(agent.pause(run.runId, 'pause_before_selection'));
    });
    await expect(run.result).resolves.toMatchObject({ status: 'paused' });
    await Promise.all(pauses);
    const history = parseRuntimeCheckpoint(
      (await agent.inspect(run.runId))!.checkpoint,
    ).state.recentChoices;
    expect(pauses).toHaveLength(1);
    expect(
      history.filter((entry) => entry.kind === 'selectionDiscarded'),
    ).toEqual([
      expect.objectContaining({
        selectionId: history.find((entry) => entry.kind === 'selectionStarted')!
          .selectionId,
        reasonCode: 'pause_before_selection',
        candidate: null,
      }),
    ]);
    expect(h.select).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
  } finally {
    await agent.close();
  }
});

test('discards an invalidated single-call selection and ignores its late result', async () => {
  const h = runnerFixture(0, 1);
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let late!: Promise<SelectionResult>;
  const select = h.select.getMockImplementation()!;
  h.select.mockImplementationOnce((request, control) => {
    enter();
    late = blocked.then(() => select(request, control));
    return late;
  });
  h.select.mockImplementationOnce(async (request, control) => {
    release();
    await late;
    return select(request, control);
  });
  const agent = h.create();
  try {
    const run = await agent.start(h.input);
    await entered;
    await agent.emit(applicationEvent({ impact: 'candidates' }));
    await expect(run.result).resolves.toMatchObject({ status: 'succeeded' });
    await late;
    const history = parseRuntimeCheckpoint(
      (await agent.inspect(run.runId))!.checkpoint,
    ).state.recentChoices.filter((entry) => entry.kind !== 'decision');
    expect(history).toEqual([
      expect.objectContaining({
        kind: 'selectionStarted',
        selectionId: h.select.mock.calls[0]![0].requestId,
      }),
      expect.objectContaining({
        kind: 'selectionDiscarded',
        selectionId: h.select.mock.calls[0]![0].requestId,
        reasonCode: 'basis_changed',
        candidate: null,
      }),
      expect.objectContaining({
        kind: 'selectionStarted',
        selectionId: h.select.mock.calls[1]![0].requestId,
      }),
      expect.objectContaining({
        kind: 'selectionResult',
        selectionId: h.select.mock.calls[1]![0].requestId,
        comparisonComplete: true,
        outcome: 'selected',
      }),
    ]);
    expect(h.select).toHaveBeenCalledTimes(2);
    expect(h.execute).toHaveBeenCalledTimes(1);
  } finally {
    release();
    await agent.close();
  }
});

test('records a single-call abstention without a later discard', async () => {
  const h = runnerFixture(0, 1);
  h.select.mockImplementationOnce((request) =>
    Promise.resolve({
      outcome: 'abstain',
      decisionId: request.requestId,
      candidateSetId: request.candidates.id,
      reason: 'no_suitable_call',
    }),
  );
  const agent = h.create();
  try {
    const run = await agent.start(h.input);
    await expect(run.result).resolves.toMatchObject({ status: 'paused' });
    const history = parseRuntimeCheckpoint(
      (await agent.inspect(run.runId))!.checkpoint,
    ).state.recentChoices.filter((entry) => entry.kind !== 'decision');
    expect(history).toEqual([
      expect.objectContaining({ kind: 'selectionStarted' }),
      expect.objectContaining({
        kind: 'selectionResult',
        selectionId: h.select.mock.calls[0]![0].requestId,
        comparisonComplete: true,
        outcome: 'abstain',
        reasonCode: 'no_suitable_call',
        candidate: null,
      }),
    ]);
    expect(h.execute).not.toHaveBeenCalled();
  } finally {
    await agent.close();
  }
});

test('records one discard when pause follows acceptance of a replacement operation', async () => {
  const h = runnerFixture(0, 1);
  h.generate.mockImplementation((request) =>
    Promise.resolve(
      candidateSet(
        request,
        ['north', 'south', 'west'].map((target) => ({
          id: target,
          params: { target },
        })),
      ),
    ),
  );
  const pauses: Promise<unknown>[] = [];
  const agent = createAgent({
    ...h.options,
    decisionPolicy: {
      decide(request, control) {
        return request.input.selection === null
          ? fixtureDecisionPolicy.decide(request, control)
          : Promise.resolve({
              optionId: request.options.find(
                ({ decision }) => decision.kind === 'selectOperation',
              )!.id,
            });
      },
    },
    selector: {
      kind: 'resumable',
      batchCapacity: 2,
      async advance(request) {
        await agent.emit(applicationEvent({ impact: 'observation' }));
        return {
          decisionId: request.requestId,
          candidateSetId: request.candidates.id,
          outcome: 'selected',
          candidateId: request.candidates.candidates[0]!.id,
        };
      },
    },
  });
  try {
    const run = await agent.start(h.input);
    agent.subscribe(run.runId, (record) => {
      if (
        record.kind === 'coreEvent' &&
        record.data.type === 'selection_discarded'
      )
        pauses.push(agent.pause(run.runId, 'pause_after_reselection'));
    });
    await expect(run.result).resolves.toMatchObject({ status: 'paused' });
    await Promise.all(pauses);
    expect(pauses).toHaveLength(1);
    const discarded = parseRuntimeCheckpoint(
      (await agent.inspect(run.runId))!.checkpoint,
    ).state.recentChoices.filter(
      (entry) => entry.kind === 'selectionDiscarded',
    );
    expect(discarded).toHaveLength(1);
    expect(discarded[0]).toMatchObject({
      reasonCode: 'selectOperation',
      candidate: null,
    });
    expect(h.execute).not.toHaveBeenCalled();
  } finally {
    await agent.close();
  }
});
