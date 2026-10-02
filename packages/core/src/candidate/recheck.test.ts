import { getEventListeners } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { ActionRegistry, defineAction } from '#internal/action/registry';
import type { ActionCheck, ActionDefinition } from '#internal/contracts/action';
import type { CandidateRecheckInput } from '#internal/contracts/candidate-processing';
import type { GoalLifecycle } from '#internal/contracts/goal';
import type { ObservationFact } from '#internal/contracts/observation';
import { parseGoalGraph } from '#internal/validation/goal';
import { filterCandidates } from './filter.js';
import { recheckCandidate } from './recheck.js';
import { selectCandidates } from './select.js';
import {
  actionRegistry,
  callControl,
  checkedBatch,
  generationInput,
} from './__tests__/fixtures.js';

afterEach(() => vi.useRealTimers());

async function selectedCandidate(registry: ActionRegistry) {
  const filtering = await filterCandidates(
    await checkedBatch(registry, ['north']),
    callControl(),
  );
  if (filtering.outcome !== 'filtered')
    throw new Error('Expected filtered fixture');
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
    throw new Error('Expected selected fixture');
  return selected;
}

test.each<{
  name: string;
  fact: ObservationFact;
  expected: ActionCheck;
}>([
  {
    name: 'available',
    fact: { status: 'known', value: true },
    expected: { outcome: 'allowed' },
  },
  {
    name: 'missing',
    fact: { status: 'absent' },
    expected: { outcome: 'denied', reason: 'target_missing' },
  },
  {
    name: 'permission_lost',
    fact: { status: 'known', value: false },
    expected: { outcome: 'denied', reason: 'permission_lost' },
  },
  {
    name: 'unobserved',
    fact: { status: 'unobserved' },
    expected: { outcome: 'unknown', reason: 'unobserved' },
  },
  {
    name: 'stale',
    fact: {
      status: 'stale',
      lastKnown: true,
      lastObservedAt: '2026-10-01T00:00:00.000Z',
    },
    expected: { outcome: 'unknown', reason: 'stale' },
  },
])(
  'rechecks $name with the original parameters and constraints, preserving both observations',
  async ({ fact, expected }) => {
    let defaults = 0;
    const check = vi.fn<ActionDefinition<z.ZodObject>['check']>((context) => {
      const available = context.observation.data.available;
      if (available?.status === 'known')
        return Promise.resolve(
          available.value === true
            ? { outcome: 'allowed' }
            : { outcome: 'denied', reason: 'permission_lost' },
        );
      if (available?.status === 'absent')
        return Promise.resolve({ outcome: 'denied', reason: 'target_missing' });
      return Promise.resolve({
        outcome: 'unknown',
        reason: available?.status ?? 'not_reported',
      });
    });
    const registry = actionRegistry(
      z.strictObject({
        target: z.string(),
        count: z.number().default(() => {
          defaults += 1;
          return 1;
        }),
      }),
      check,
    );
    const selected = await selectedCandidate(registry);
    const defaultCount = defaults;
    const previous = selected.filtered.checked.prepared.request.context;
    const input = generationInput();
    const current: CandidateRecheckInput = {
      ...input,
      requestId: 'recheck-request',
      context: {
        ...input.context,
        effectiveConstraints: { protected: ['south'], maxCount: 2 },
        observation: {
          ...input.context.observation,
          id: 'fresh-observation',
          revision: 5,
          coverage: {
            scope: 'nearby',
            completeness: 'partial',
            uncheckedScopes: ['far-area'],
          },
          data: { target: { status: 'known', value: 'east' }, available: fact },
        },
      },
    };
    const result = await recheckCandidate(
      selected,
      current,
      registry,
      callControl(),
    );
    expect(result).toMatchObject({ outcome: 'rechecked', check: expected });
    expect(result.selected).toBe(selected);
    expect(result.request.requestId).toBe('recheck-request');
    expect(result.request.context.observation.revision).toBe(5);
    expect(result.request.context.observation).not.toBe(
      current.context.observation,
    );
    expect(previous.observation.revision).toBe(4);
    expect(selected.candidate.observationRef.revision).toBe(4);
    expect(check.mock.calls[1]![1]).toBe(selected.candidate.params);
    expect(check.mock.calls[1]![1]).toEqual({ target: 'north', count: 1 });
    expect(check.mock.calls[1]![0]).toBe(result.request.context);
    expect(result.request.context.effectiveConstraints).toBe(
      previous.effectiveConstraints,
    );
    expect(check).toHaveBeenCalledTimes(2);
    expect(defaults).toBe(defaultCount);
    expect(Object.isFrozen(result.request.context.observation.data)).toBe(true);
    expect(result).not.toHaveProperty('execute');
  },
);

test.each([
  ['decision_epoch', 'decision_epoch_changed'],
  ['root_version', 'root_goal_changed'],
  ['current_version', 'current_goal_changed'],
  ['ancestor_version', 'goal_path_changed'],
  ['reparented', 'goal_path_changed'],
  ['current_target', 'current_goal_changed'],
  ['criteria', 'goal_definition_changed'],
  ['root_limits', 'goal_definition_changed'],
  ['accepted_plan', 'goal_definition_changed'],
  ['plan_version', 'plan_changed'],
  ['plan_removed', 'plan_changed'],
  ['guidance', 'plan_changed'],
  ['constraints_version', 'constraints_changed'],
  ['constraints_content', 'constraints_changed'],
  ['run', 'run_changed'],
  ['older_observation', 'observation_regressed'],
  ['same_revision_content', 'observation_conflict'],
  ['same_revision_id', 'observation_conflict'],
] as const)(
  'invalidates %s before invoking the selected action',
  async (change, reason) => {
    const check = vi.fn<ActionDefinition<z.ZodObject>['check']>(() =>
      Promise.resolve({ outcome: 'allowed' }),
    );
    const registry = actionRegistry(undefined, check);
    const selected = await selectedCandidate(registry);
    let input = structuredClone(generationInput());
    const graph = input.context.graph;
    const current = graph.goals.find((goal) => goal.id === 'collect')!;
    const ancestor = graph.goals.find((goal) => goal.id === 'area')!;
    switch (change) {
      case 'decision_epoch':
        Reflect.set(input, 'decisionEpoch', 4);
        break;
      case 'root_version':
        input = generationInput(2);
        break;
      case 'current_version':
        Reflect.set(current, 'version', 2);
        Reflect.set(graph, 'currentGoalRef', { id: 'collect', version: 2 });
        break;
      case 'ancestor_version':
        Reflect.set(ancestor, 'version', 2);
        Reflect.set(current, 'parentGoalRef', { id: 'area', version: 2 });
        break;
      case 'reparented':
        Reflect.set(current, 'parentGoalRef', graph.rootGoalRef);
        break;
      case 'current_target':
        Reflect.set(graph, 'currentGoalRef', { id: 'area', version: 1 });
        break;
      case 'criteria':
        Reflect.set(current, 'criteria', { count: 3 });
        break;
      case 'root_limits':
        Reflect.set(graph.goals[0]!, 'limits', { actions: 20 });
        break;
      case 'accepted_plan':
        Reflect.set(current, 'acceptedPlanRef', {
          id: 'plan',
          version: 2,
          rootGoalVersion: 1,
        });
        break;
      case 'plan_version':
        Reflect.set(input.context, 'planRef', {
          id: 'plan',
          version: 2,
          rootGoalVersion: 1,
        });
        break;
      case 'plan_removed':
        Reflect.set(input.context, 'planRef', null);
        break;
      case 'guidance':
        Reflect.set(input.context, 'planGuidance', 'Use distant samples');
        break;
      case 'constraints_version':
        Reflect.set(input.context, 'constraintsVersion', 3);
        break;
      case 'constraints_content':
        Reflect.set(input.context.effectiveConstraints, 'maxCount', 3);
        break;
      case 'run':
        Reflect.set(graph, 'runId', 'other-run');
        for (const goal of graph.goals) Reflect.set(goal, 'runId', 'other-run');
        Reflect.set(input.context.observation, 'runId', 'other-run');
        break;
      case 'older_observation':
        Reflect.set(input.context.observation, 'revision', 3);
        break;
      case 'same_revision_content':
        Reflect.set(input.context.observation.data, 'available', {
          status: 'known',
          value: false,
        });
        break;
      case 'same_revision_id':
        Reflect.set(input.context.observation, 'id', 'different-id');
        break;
    }
    const nextGraph = input.context.graph;
    input = {
      ...input,
      context: {
        ...input.context,
        graph: parseGoalGraph({
          runId: nextGraph.runId,
          rootGoalRef: nextGraph.rootGoalRef,
          currentGoalRef: nextGraph.currentGoalRef,
          goals: nextGraph.goals,
        }),
      },
    };
    const result = await recheckCandidate(
      selected,
      input,
      registry,
      callControl(),
    );
    expect(result).toMatchObject({ outcome: 'invalidated', reason });
    expect(result).not.toHaveProperty('check');
    expect(result.selected).toBe(selected);
    expect(check).toHaveBeenCalledOnce();
  },
);

test.each(['root', 'area', 'collect'])(
  'blocks terminal lifecycle states on %s',
  async (goalId) => {
    const check = vi.fn<ActionDefinition<z.ZodObject>['check']>(() =>
      Promise.resolve({ outcome: 'allowed' }),
    );
    const registry = actionRegistry(undefined, check);
    const selected = await selectedCandidate(registry);
    for (const lifecycle of [
      'succeeded',
      'cancelled',
      'superseded',
    ] satisfies GoalLifecycle[]) {
      const input = generationInput();
      const goal = input.context.graph.goals.find(
        (entry) => entry.id === goalId,
      )!;
      const current = {
        ...input,
        context: {
          ...input.context,
          graph: {
            ...input.context.graph,
            goals: input.context.graph.goals.map((entry) =>
              entry.id !== goalId
                ? entry
                : {
                    ...entry,
                    lifecycle,
                    lastAssessment:
                      lifecycle === 'succeeded'
                        ? {
                            goalRef: { id: goal.id, version: goal.version },
                            observationRef: {
                              id: input.context.observation.id,
                              revision: input.context.observation.revision,
                            },
                            outcome: 'passed' as const,
                            reason: null,
                            evidence: {
                              source: 'application' as const,
                              observationPaths: ['/data/available'],
                              executionIds: [],
                              details: {},
                            },
                          }
                        : null,
                  },
            ),
          },
        },
      };
      expect(
        await recheckCandidate(selected, current, registry, callControl()),
      ).toMatchObject({
        outcome: 'invalidated',
        reason: 'inactive_goal_path',
      });
    }
    expect(check).toHaveBeenCalledOnce();
  },
);

test('allows active lifecycle progress, sibling changes, and equivalent key order', async () => {
  const registry = actionRegistry();
  const selected = await selectedCandidate(registry);
  const input = generationInput();
  const current = {
    ...input,
    context: {
      ...input.context,
      effectiveConstraints: { protected: ['south'], maxCount: 2 },
      observation: {
        ...input.context.observation,
        data: {
          available: { status: 'known' as const, value: true },
          target: { status: 'known' as const, value: 'north' },
        },
      },
      graph: {
        ...input.context.graph,
        goals: input.context.graph.goals.map((goal) => {
          if (goal.id === 'collect')
            return { ...goal, lifecycle: 'inProgress' as const };
          if (goal.id === 'old-area')
            return {
              ...goal,
              description: 'Replaced sibling',
              lifecycle: 'superseded' as const,
            };
          return goal;
        }),
      },
    },
  };
  expect(
    await recheckCandidate(selected, current, registry, callControl()),
  ).toMatchObject({
    outcome: 'rechecked',
    check: { outcome: 'allowed' },
  });
});

test.each(['missing', 'new_version', 'new_registration'] as const)(
  'rejects %s of the selected action',
  async (change) => {
    const check = vi.fn<ActionDefinition<z.ZodObject>['check']>(() =>
      Promise.resolve({ outcome: 'allowed' }),
    );
    const registry = actionRegistry(undefined, check);
    const selected = await selectedCandidate(registry);
    const replacement =
      change === 'missing'
        ? new ActionRegistry([])
        : change === 'new_registration'
          ? actionRegistry()
          : new ActionRegistry([
              defineAction({
                id: 'collect',
                version: 2,
                description: 'Collect samples',
                tags: [],
                expectedEffects: {},
                parameters: z.strictObject({
                  target: z.string(),
                  count: z.number().default(1),
                }),
                check,
                execute: () => {
                  throw new Error('must not execute');
                },
              }),
            ]);
    const expected =
      change === 'missing'
        ? 'action_unavailable'
        : change === 'new_version'
          ? 'action_version_changed'
          : 'action_registration_changed';
    expect(
      await recheckCandidate(
        selected,
        generationInput(),
        replacement,
        callControl(),
      ),
    ).toMatchObject({
      outcome: 'invalidated',
      reason: expected,
    });
    expect(check).toHaveBeenCalledOnce();
  },
);

test('accepts the same registration in a new registry and ignores unrelated new actions', async () => {
  const action = defineAction({
    id: 'collect',
    version: 1,
    description: 'Collect samples',
    tags: [],
    expectedEffects: {},
    parameters: z.strictObject({
      target: z.string(),
      count: z.number().default(1),
    }),
    check: () => Promise.resolve({ outcome: 'allowed' }),
    execute: () => {
      throw new Error('must not execute');
    },
  });
  const selected = await selectedCandidate(new ActionRegistry([action]));
  const registry = new ActionRegistry([
    action,
    defineAction({
      id: 'inspect',
      version: 1,
      description: 'Inspect area',
      tags: [],
      expectedEffects: {},
      parameters: z.strictObject({}),
      check: () => Promise.resolve({ outcome: 'allowed' }),
      execute: () => {
        throw new Error('must not execute');
      },
    }),
  ]);
  expect(
    await recheckCandidate(
      selected,
      generationInput(),
      registry,
      callControl(),
    ),
  ).toMatchObject({
    outcome: 'rechecked',
    check: { outcome: 'allowed' },
  });
});

test.each(['throw', 'reject'] as const)(
  'reports a recheck callback %s without retry or domain translation',
  async (kind) => {
    const check = vi.fn<ActionDefinition<z.ZodObject>['check']>(() =>
      Promise.resolve({ outcome: 'allowed' }),
    );
    const registry = actionRegistry(undefined, check);
    const selected = await selectedCandidate(registry);
    check.mockImplementationOnce(() => {
      if (kind === 'throw') throw new Error('private callback failure');
      return Promise.reject(new Error('private callback failure'));
    });
    const result = await recheckCandidate(
      selected,
      generationInput(),
      registry,
      callControl(),
    );
    expect(result).toMatchObject({
      outcome: 'failed',
      stage: 'rechecking',
      reason: 'callback_failed',
      issue: null,
    });
    expect(result).not.toHaveProperty('check');
    expect(JSON.stringify(result)).not.toContain('private callback failure');
    expect(check).toHaveBeenCalledTimes(2);
  },
);

test.each([
  undefined,
  { outcome: 'allowed', extra: true },
  { outcome: 'denied', reason: '' },
  { outcome: 'unknown' },
  { outcome: 'selected' },
  { outcome: 'allowed', value: Infinity },
])('rejects malformed recheck output %j', async (value) => {
  const check = vi.fn<ActionDefinition<z.ZodObject>['check']>(() =>
    Promise.resolve({ outcome: 'allowed' }),
  );
  const registry = actionRegistry(undefined, check);
  const selected = await selectedCandidate(registry);
  // @ts-expect-error Deliberately simulate an adapter violating its declared check contract.
  check.mockResolvedValueOnce(value);
  const result = await recheckCandidate(
    selected,
    generationInput(),
    registry,
    callControl(),
  );
  expect(result).toMatchObject({ outcome: 'failed', reason: 'invalid_result' });
  expect(result).not.toHaveProperty('check');
  if (result.outcome !== 'failed') throw new Error('Expected contract failure');
  expect(result.issue).not.toBeNull();
  expect(check).toHaveBeenCalledTimes(2);
});

test.each(['cancelled', 'deadlineExceeded'] as const)(
  'stops waiting after %s and observes a late answer',
  async (outcome) => {
    vi.useFakeTimers();
    const check = vi.fn<ActionDefinition<z.ZodObject>['check']>(() =>
      Promise.resolve({ outcome: 'allowed' }),
    );
    const registry = actionRegistry(undefined, check);
    const selected = await selectedCandidate(registry);
    let resolve!: (value: ActionCheck) => void;
    let reject!: (reason: unknown) => void;
    check.mockImplementationOnce(
      () =>
        new Promise((done, fail) => {
          resolve = done;
          reject = fail;
        }),
    );
    const parent = new AbortController();
    const pending = recheckCandidate(selected, generationInput(), registry, {
      signal: parent.signal,
      deadlineAt: new Date(Date.now() + 20).toISOString(),
    });
    const invocation = check.mock.calls[1]![2];
    if (outcome === 'cancelled') parent.abort();
    else await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toMatchObject({ outcome, stage: 'rechecking' });
    expect(invocation.signal.aborted).toBe(true);
    expect(getEventListeners(parent.signal, 'abort')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    if (outcome === 'cancelled') resolve({ outcome: 'allowed' });
    else reject(new Error('late rejection'));
    await Promise.resolve();
    expect(check).toHaveBeenCalledTimes(2);
  },
);

test('captures separate concurrent requests and never accepts cancellation during validation', async () => {
  const check = vi.fn<ActionDefinition<z.ZodObject>['check']>(() =>
    Promise.resolve({ outcome: 'allowed' }),
  );
  const registry = actionRegistry(undefined, check);
  const selected = await selectedCandidate(registry);
  const pendingChecks: ((value: ActionCheck) => void)[] = [];
  check.mockImplementation(
    () => new Promise((resolve) => pendingChecks.push(resolve)),
  );
  const input = structuredClone(generationInput());
  const first = recheckCandidate(selected, input, registry, callControl());
  Reflect.set(input, 'requestId', 'second');
  Reflect.set(input.context.observation, 'revision', 5);
  const second = recheckCandidate(selected, input, registry, callControl());
  Reflect.set(input.context.effectiveConstraints, 'maxCount', 999);
  expect(check.mock.calls[1]![0]).not.toBe(check.mock.calls[2]![0]);
  expect(check.mock.calls[1]![2].signal).not.toBe(
    check.mock.calls[2]![2].signal,
  );
  pendingChecks[1]!({ outcome: 'denied', reason: 'target_missing' });
  pendingChecks[0]!({ outcome: 'allowed' });
  const [one, two] = await Promise.all([first, second]);
  expect(one).toMatchObject({
    outcome: 'rechecked',
    request: {
      requestId: 'request',
      context: { observation: { revision: 4 } },
    },
    check: { outcome: 'allowed' },
  });
  expect(two).toMatchObject({
    outcome: 'rechecked',
    request: { requestId: 'second', context: { observation: { revision: 5 } } },
    check: { outcome: 'denied', reason: 'target_missing' },
  });
  expect(one.request.context.effectiveConstraints.maxCount).toBe(2);
  expect(two.request.context.effectiveConstraints.maxCount).toBe(2);

  const parent = new AbortController();
  check.mockResolvedValueOnce(
    new Proxy(
      { outcome: 'allowed' },
      {
        ownKeys(target) {
          parent.abort();
          return Reflect.ownKeys(target);
        },
      },
    ),
  );
  expect(
    await recheckCandidate(
      selected,
      generationInput(),
      registry,
      callControl(parent.signal),
    ),
  ).toMatchObject({
    outcome: 'cancelled',
    stage: 'rechecking',
  });
});

test('checks interruption before invalidation and rejects malformed inputs or copied selections', async () => {
  const check = vi.fn<ActionDefinition<z.ZodObject>['check']>(() =>
    Promise.resolve({ outcome: 'allowed' }),
  );
  const registry = actionRegistry(undefined, check);
  const selected = await selectedCandidate(registry);
  const parent = new AbortController();
  parent.abort();
  expect(
    await recheckCandidate(
      selected,
      generationInput(2),
      registry,
      callControl(parent.signal),
    ),
  ).toMatchObject({ outcome: 'cancelled' });
  expect(
    await recheckCandidate(selected, generationInput(), registry, {
      signal: new AbortController().signal,
      deadlineAt: new Date(Date.now() - 1).toISOString(),
    }),
  ).toMatchObject({ outcome: 'deadlineExceeded' });
  await expect(
    recheckCandidate(
      { ...selected },
      generationInput(),
      registry,
      callControl(),
    ),
  ).rejects.toMatchObject({ reason: 'unselected_candidate' });
  const input = generationInput();
  await expect(
    recheckCandidate(
      selected,
      {
        ...input,
        context: {
          ...input.context,
          graph: { ...input.context.graph, goalPath: [] },
        },
      },
      registry,
      callControl(),
    ),
  ).rejects.toMatchObject({ reason: 'goal_path_mismatch' });
  expect(check).toHaveBeenCalledOnce();
});
