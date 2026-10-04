import { expect, test } from 'vitest';
import type { CallControl } from '#internal/contracts/control';
import type { PlannerRequest } from '#internal/planner/contracts';
import type { SelectorRequest } from '#internal/selector/contracts';
import { createAgent } from './agent.js';
import { proposalBasis, runnerFixture } from './__tests__/runner-fixtures.js';

test('meters declared roles even with empty modelStages and captures identities without losing method receivers', async () => {
  const h = runnerFixture(0, 1);
  const planner = {
    model: { provider: 'fixture', model: 'planning-model' },
    calls: 0,
    plan(request: PlannerRequest, control: CallControl) {
      this.calls++;
      control.reportModelResponse!({
        model: 'actual-planning',
        requestId: 'plan-response',
        usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      });
      return h.plan(request, control);
    },
  };
  const selector = {
    model: { provider: 'other', model: 'selection-model' },
    calls: 0,
    select(request: SelectorRequest, control: CallControl) {
      this.calls++;
      control.reportModelResponse!({
        model: 'actual-selection',
        requestId: 'select-response',
        usage: null,
      });
      return h.select(request, control);
    },
  };
  const agent = createAgent({
    ...h.options,
    planner,
    selector,
    modelStages: [],
  });
  planner.model.model = 'mutated-after-creation';
  selector.model.provider = 'mutated-after-creation';
  const run = await agent.start(h.input);
  await expect(run.result).resolves.toMatchObject({ status: 'succeeded' });
  const state = (await agent.inspect(run.runId))!.checkpoint.state;
  expect(state).toMatchObject({
    modelAttempts: 2,
    identity: { modelStages: ['planning', 'selection'] },
  });
  expect(planner.calls).toBe(1);
  expect(selector.calls).toBe(1);
  const finished = (await agent.records(run.runId, null, 1000)).records.filter(
    (record) =>
      record.kind === 'coreEvent' && record.data.type === 'model_finished',
  );
  expect(finished).toMatchObject([
    {
      data: {
        details: {
          purpose: 'planning',
          model: { provider: 'fixture', model: 'planning-model' },
          response: { model: 'actual-planning', requestId: 'plan-response' },
          usage: { totalTokens: 7 },
        },
      },
    },
    {
      data: {
        details: {
          purpose: 'selection',
          model: { provider: 'other', model: 'selection-model' },
          response: { model: 'actual-selection', requestId: 'select-response' },
          usage: null,
        },
      },
    },
  ]);
  await agent.close();
});

test('checks the model budget before dispatching an automatically metered role', async () => {
  const h = runnerFixture();
  const agent = createAgent({
    ...h.options,
    planner: {
      model: { provider: 'fixture', model: 'configured' },
      plan: h.plan,
    },
    modelStages: [],
    limits: { maxModelAttempts: 0 },
  });
  const run = await agent.start(h.input);
  await expect(run.result).resolves.toMatchObject({
    status: 'paused',
    blocker: { reasonCode: 'model_budget_exhausted' },
  });
  expect(h.plan).not.toHaveBeenCalled();
  expect(h.execute).not.toHaveBeenCalled();
  await agent.close();
});

test('restores automatic model stages with cumulative budgets and rejects a changed stage declaration', async () => {
  const h = runnerFixture();
  h.plan.mockImplementation((request) =>
    Promise.resolve({
      ...proposalBasis(request),
      outcome: 'blocked',
      reason: 'needs_input',
    }),
  );
  const first = createAgent({
    ...h.options,
    planner: { model: { provider: 'fixture', model: 'first' }, plan: h.plan },
    limits: { maxModelAttempts: 1 },
  });
  await (
    await first.start(h.input)
  ).result;
  await first.close();
  const incompatible = h.create();
  await expect(incompatible.resume('run')).rejects.toMatchObject({
    reason: 'identity_mismatch',
    path: '/identity/modelStages',
  });
  await incompatible.close();
  const resumed = createAgent({
    ...h.options,
    planner: {
      model: { provider: 'fixture', model: 'replacement' },
      plan: h.plan,
    },
    modelStages: [],
  });
  await expect((await resumed.resume('run')).result).resolves.toMatchObject({
    status: 'paused',
    blocker: { reasonCode: 'model_budget_exhausted' },
  });
  expect(h.plan).toHaveBeenCalledTimes(1);
  expect((await resumed.inspect('run'))?.checkpoint.state.modelAttempts).toBe(
    1,
  );
  await resumed.close();
});

test('validates declared model identities during construction without invoking callbacks', () => {
  const h = runnerFixture();
  expect(() =>
    createAgent({
      ...h.options,
      planner: { model: { provider: 'fixture', model: '' }, plan: h.plan },
    }),
  ).toThrow(expect.objectContaining({ reason: 'expected_nonempty_string' }));
  const identity = {
    provider: 'fixture',
    model: 'configured',
    apiKey: 'must-not-persist',
  };
  expect(() =>
    createAgent({
      ...h.options,
      selector: { model: identity, select: h.select },
    }),
  ).toThrow(expect.objectContaining({ reason: 'unknown_field' }));
  expect(h.plan).not.toHaveBeenCalled();
  expect(h.select).not.toHaveBeenCalled();
});
