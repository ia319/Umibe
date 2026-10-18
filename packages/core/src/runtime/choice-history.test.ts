import { expect, test, vi } from 'vitest';
import type {
  ChoiceRequest,
  StructuredOutputRequest,
} from '#internal/model/contracts';
import { createDecisionPolicy } from '#internal/decision/model';
import { createPlanner } from '#internal/planner/model';
import { createSelector } from '#internal/selector/model';
import { MemoryRunStore } from '#internal/storage/memory';
import { generationInput } from '#internal/candidate/__tests__/fixtures';
import { createAgent } from './agent.js';
import { RunSession } from './session.js';
import { parseRuntimeCheckpoint } from './checkpoint.js';
import {
  fixtureDecisionPolicy,
  runnerFixture,
} from './__tests__/runner-fixtures.js';

test('projects accepted control decisions to all model roles', async () => {
  const h = runnerFixture(0, 1);
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
      overflow: 'reject',
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
    expect(decisionMessages[0]!.instructions).toHaveProperty(
      'references.recentChoices',
      [],
    );
    expect(decisionMessages.at(-1)!.instructions).toHaveProperty(
      'references.recentChoices.0.choice.kind',
      'replan',
    );
    expect(planningMessages[0]!.input).toHaveProperty(
      'context.recentChoices.0.choice.kind',
      'replan',
    );
    const history = parseRuntimeCheckpoint(
      (await agent.inspect(run.runId))!.checkpoint,
    ).state.recentChoices;
    expect(history.map(({ choice }) => choice.kind)).toEqual([
      'replan',
      'adoptPlan',
      'selectOperation',
    ]);
    expect(selectionMessages).toHaveLength(1);
    expect(selectionMessages[0]!.instructions).toHaveProperty(
      'references.context.recentChoices',
      history,
    );
    expect(h.execute).toHaveBeenCalledTimes(1);
  } finally {
    await agent.close();
  }
});

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
