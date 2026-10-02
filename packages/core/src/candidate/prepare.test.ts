import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import { defineAction } from '#internal/action/registry';
import type { CandidateRequest } from '#internal/contracts/adapters';
import type { CandidateSet } from '#internal/contracts/candidate';
import type { JsonValue } from '#internal/contracts/json';
import { parseCandidateSet } from '#internal/validation/candidate';
import { canonicalJson } from './identity.js';
import { prepareCandidates } from './prepare.js';
import {
  actionRegistry,
  callControl,
  candidateSet,
  generationInput,
} from './__tests__/fixtures.js';

test('captures the whole request before generation and returns a separate normalized set', async () => {
  const input = structuredClone(generationInput());
  const check = vi.fn(() => Promise.resolve({ outcome: 'allowed' as const }));
  const registry = actionRegistry(undefined, check);
  const generate = vi.fn((request: CandidateRequest) =>
    Promise.resolve(
      candidateSet(request, [{ id: 'first', params: { target: 'north' } }]),
    ),
  );
  const pending = prepareCandidates(
    input,
    registry,
    { generate },
    callControl(),
  );
  Reflect.set(input, 'requestId', 'mutated');
  Reflect.set(input.context.graph.goals[0]!, 'criteria', { count: 99 });
  Reflect.set(input.context.effectiveConstraints, 'maxCount', 99);
  const result = await pending;
  expect(result.outcome).toBe('prepared');
  if (result.outcome !== 'prepared') return;
  const { prepared } = result;
  expect(prepared.request.requestId).toBe('request');
  expect(prepared.request.decisionEpoch).toBe(3);
  expect(prepared.request.context.graph.goalPath.map((ref) => ref.id)).toEqual([
    'root',
    'area',
    'collect',
  ]);
  expect(prepared.request.context.graph.goals[0]!.criteria).toEqual({
    count: 2,
  });
  expect(prepared.request.context.effectiveConstraints.maxCount).toBe(2);
  expect(prepared.request.capabilities[0]?.id).toBe('collect');
  expect(
    Object.isFrozen(prepared.request.context.effectiveConstraints.protected),
  ).toBe(true);
  expect(prepared.set.id).not.toBe(prepared.providerSet.id);
  expect(prepared.set.goalPathRef).not.toBe(prepared.providerSet.goalPathRef);
  expect(prepared.set.candidates[0]?.params).toEqual({
    target: 'north',
    count: 1,
  });
  expect(prepared.set.candidates[0]?.paramSources.count?.kind).toBe('default');
  expect(prepared.report).toMatchObject({
    received: 1,
    normalized: 1,
    excluded: 0,
    merged: 0,
    remaining: 0,
  });
  expect(prepared.providerSet.candidates[0]?.params).toEqual({
    target: 'north',
  });
  expect(prepared.set.coverage.checking).toBe('partial');
  expect(parseCandidateSet(prepared.set)).toEqual(prepared.set);
  expect(check).not.toHaveBeenCalled();
});

test('requires an accepted plan and verifies the supplied derived path before calling the provider', async () => {
  const input = generationInput();
  const generate = vi.fn(() => Promise.reject(new Error('must not run')));
  for (const [context, reason] of [
    [{ ...input.context, planRef: null }, 'missing_plan'],
    [
      {
        ...input.context,
        planRef: { id: 'plan', version: 1, rootGoalVersion: 99 },
      },
      'stale_root_version',
    ],
    [
      {
        ...input.context,
        graph: {
          ...input.context.graph,
          goalPath: [
            input.context.graph.rootGoalRef,
            input.context.graph.currentGoalRef,
          ],
        },
      },
      'goal_path_mismatch',
    ],
    [
      {
        ...input.context,
        observation: { ...input.context.observation, runId: 'another-run' },
      },
      'cross_run_observation',
    ],
  ] as const) {
    await expect(
      prepareCandidates(
        { ...input, context },
        actionRegistry(),
        { generate },
        callControl(),
      ),
    ).rejects.toMatchObject({ reason });
  }
  expect(generate).not.toHaveBeenCalled();
});

test.each([
  'pending',
  'inProgress',
  'succeeded',
  'cancelled',
  'superseded',
] as const)(
  'checks lifecycle %s on the entire current path while permitting an inactive sibling',
  async (lifecycle) => {
    const input = generationInput();
    const ancestor = input.context.graph.goals[1]!;
    const assessment =
      lifecycle === 'succeeded'
        ? {
            goalRef: { id: ancestor.id, version: ancestor.version },
            observationRef: {
              id: input.context.observation.id,
              revision: input.context.observation.revision,
            },
            outcome: 'passed' as const,
            reason: null,
            evidence: {
              source: 'application' as const,
              observationPaths: ['/data/target'],
              executionIds: [],
              details: {},
            },
          }
        : null;
    const graph = {
      ...input.context.graph,
      goals: input.context.graph.goals.map((goal) =>
        goal.id === ancestor.id
          ? { ...goal, lifecycle, lastAssessment: assessment }
          : goal,
      ),
    };
    const generate = vi.fn((request: CandidateRequest) =>
      Promise.resolve(candidateSet(request, [])),
    );
    const result = prepareCandidates(
      { ...input, context: { ...input.context, graph } },
      actionRegistry(),
      { generate },
      callControl(),
    );
    if (lifecycle === 'pending' || lifecycle === 'inProgress') {
      expect((await result).outcome).toBe('prepared');
      expect(generate).toHaveBeenCalledOnce();
    } else {
      await expect(result).rejects.toMatchObject({
        reason: 'inactive_goal_path',
      });
      expect(generate).not.toHaveBeenCalled();
    }
  },
);

test('a changed target count reaches providers and an old root version invalidates the whole answer', async () => {
  const oldInput = generationInput(1, 2);
  const current = generationInput(2, 5);
  const generate = vi.fn((request: CandidateRequest) => {
    expect(request.context.graph.goals[0]?.criteria).toEqual({ count: 5 });
    expect(request.context.effectiveConstraints.maxCount).toBe(5);
    return Promise.resolve(
      candidateSet({ ...request, context: oldInput.context }, [
        { id: 'old', params: { target: 'north' } },
      ]),
    );
  });
  const result = await prepareCandidates(
    current,
    actionRegistry(),
    { generate },
    callControl(),
  );
  expect(result).toMatchObject({
    outcome: 'failed',
    stage: 'generation',
    reason: 'invalid_result',
    issue: { path: '/rootGoalRef', reason: 'request_basis_mismatch' },
    providerSet: null,
    report: { received: null, normalized: 0 },
  });
});

test.each([
  'runId',
  'currentGoalRef',
  'goalPath',
  'planRef',
  'observationRef',
  'constraintsVersion',
] as const)(
  'rejects a structurally consistent provider set with a different %s',
  async (key) => {
    const generate = (request: CandidateRequest) => {
      const original = candidateSet(request, [
        { id: 'first', params: { target: 'north' } },
      ]);
      let set: CandidateSet;
      const candidate = original.candidates[0]!;
      switch (key) {
        case 'runId':
          set = { ...original, runId: 'other' };
          break;
        case 'currentGoalRef': {
          const ref = { id: 'sibling', version: 1 };
          set = {
            ...original,
            currentGoalRef: ref,
            goalPath: [...original.goalPath.slice(0, -1), ref],
            candidates: [{ ...candidate, goalRef: ref }],
          };
          break;
        }
        case 'goalPath':
          set = {
            ...original,
            goalPath: [
              original.rootGoalRef,
              { id: 'wrong-parent', version: 1 },
              original.currentGoalRef,
            ],
          };
          break;
        case 'planRef': {
          const planRef = { ...original.planRef, version: 2 };
          set = {
            ...original,
            planRef,
            candidates: [{ ...candidate, planRef }],
          };
          break;
        }
        case 'observationRef': {
          const observationRef = { id: 'new-observation', revision: 5 };
          set = {
            ...original,
            observationRef,
            candidates: [{ ...candidate, observationRef }],
          };
          break;
        }
        case 'constraintsVersion':
          set = {
            ...original,
            constraintsVersion: 3,
            candidates: [{ ...candidate, constraintsVersion: 3 }],
          };
          break;
      }
      return Promise.resolve(set);
    };
    const result = await prepareCandidates(
      generationInput(),
      actionRegistry(),
      { generate },
      callControl(),
    );
    expect(result).toMatchObject({
      outcome: 'failed',
      issue: { path: `/${key}`, reason: 'request_basis_mismatch' },
    });
  },
);

test('rejects an entire malformed provider result before any parameter schema runs', async () => {
  const refinement = vi.fn(() => true);
  const registry = actionRegistry(
    z.object({ target: z.string().refine(refinement) }),
  );
  for (const fault of ['duplicate', 'basis', 'source', 'json']) {
    const generate = (request: CandidateRequest) => {
      const set = candidateSet(request, [
        { id: 'first', params: { target: 'north' } },
      ]);
      if (fault === 'duplicate') set.candidates.push({ ...set.candidates[0]! });
      if (fault === 'basis') set.candidates[0]!.candidateSetId = 'different';
      if (fault === 'source')
        Reflect.deleteProperty(set.candidates[0]!.paramSources, 'target');
      if (fault === 'json') set.candidates[0]!.params.target = Infinity;
      return Promise.resolve(set);
    };
    const result = await prepareCandidates(
      generationInput(),
      registry,
      { generate },
      callControl(),
    );
    expect(result).toMatchObject({
      outcome: 'failed',
      stage: 'generation',
      reason: 'invalid_result',
      report: { received: null },
    });
  }
  expect(refinement).not.toHaveBeenCalled();
});

test('excludes unknown actions, wrong versions and invalid parameters individually', async () => {
  const generate = (request: CandidateRequest) => {
    const set = candidateSet(request, [
      { id: 'unknown', params: { target: 'north' } },
      { id: 'version', params: { target: 'north' } },
      { id: 'invalid', params: { target: 'north', count: 0 } },
      { id: 'valid', params: { target: 'south' } },
    ]);
    set.candidates[0]!.actionId = 'missing';
    set.candidates[1]!.actionVersion = 2;
    return Promise.resolve(set);
  };
  const result = await prepareCandidates(
    generationInput(),
    actionRegistry(),
    { generate },
    callControl(),
  );
  if (result.outcome !== 'prepared')
    throw new Error('Expected prepared candidates');
  expect(
    result.prepared.set.candidates.map((candidate) => candidate.params.target),
  ).toEqual(['south']);
  expect(result.prepared.report).toMatchObject({
    received: 4,
    normalized: 1,
    excluded: 3,
    merged: 0,
    remaining: 0,
  });
  expect(result.prepared.report.entries.map((entry) => entry.reason)).toEqual([
    'unknown_action',
    'action_version_mismatch',
    'schema_too_small',
    null,
  ]);
  expect(result.prepared.report.entries[2]?.issue?.path).toBe('/params/count');
});

test('uses canonical normalized calls for stable identities and retains all duplicate origins', async () => {
  const registry = actionRegistry(
    z.object({
      target: z.string(),
      details: z.object({ a: z.number(), b: z.number() }),
      sequence: z.array(z.number()),
      count: z.number().default(1),
    }),
  );
  const generate = (request: CandidateRequest) =>
    Promise.resolve(
      candidateSet(request, [
        {
          id: 'random-one',
          params: {
            target: 'north',
            details: { b: 2, a: 1 },
            sequence: [1, 2],
          },
        },
        {
          id: 'random-two',
          params: {
            count: 1,
            sequence: [1, 2],
            details: { a: 1, b: 2 },
            target: 'north',
          },
        },
        {
          id: 'different-array',
          params: {
            target: 'north',
            details: { b: 2, a: 1 },
            sequence: [2, 1],
          },
        },
      ]),
    );
  const first = await prepareCandidates(
    generationInput(),
    registry,
    { generate },
    callControl(),
  );
  const second = await prepareCandidates(
    generationInput(),
    registry,
    { generate },
    callControl(),
  );
  if (first.outcome !== 'prepared' || second.outcome !== 'prepared')
    throw new Error('Expected prepared candidates');
  expect(first.prepared.set.id).not.toBe(second.prepared.set.id);
  expect(
    first.prepared.set.candidates.map((candidate) => candidate.id),
  ).toEqual(second.prepared.set.candidates.map((candidate) => candidate.id));
  expect(first.prepared.set.candidates).toHaveLength(2);
  expect(first.prepared.report).toMatchObject({
    received: 3,
    normalized: 3,
    merged: 1,
    excluded: 0,
  });
  expect(first.prepared.report.entries[0]?.callId).toBe(
    first.prepared.report.entries[1]?.callId,
  );
  expect(first.prepared.report.entries[0]?.callId).not.toBe(
    first.prepared.report.entries[2]?.callId,
  );
  expect(
    first.prepared.providerSet.candidates.map((candidate) => candidate.id),
  ).toEqual(['random-one', 'random-two', 'different-array']);
  expect(first.prepared.report.entries[0]?.parameterChanges).toEqual([
    { kind: 'added', path: '/count' },
  ]);
  expect(first.prepared.report.entries[1]?.parameterChanges).toEqual([]);
});

test.each(['cost', 'risk', 'expectedEffects'] as const)(
  'excludes every duplicate with conflicting %s',
  async (key) => {
    const generate = (request: CandidateRequest) => {
      const set = candidateSet(request, [
        { id: 'first', params: { target: 'north' } },
        { id: 'second', params: { target: 'north' } },
        { id: 'other', params: { target: 'south' } },
      ]);
      Reflect.set(set.candidates[1]!, key, { different: true });
      return Promise.resolve(set);
    };
    const result = await prepareCandidates(
      generationInput(),
      actionRegistry(),
      { generate },
      callControl(),
    );
    if (result.outcome !== 'prepared')
      throw new Error('Expected prepared candidates');
    expect(
      result.prepared.set.candidates.map(
        (candidate) => candidate.params.target,
      ),
    ).toEqual(['south']);
    expect(result.prepared.report).toMatchObject({
      normalized: 3,
      excluded: 2,
      merged: 0,
    });
    expect(
      result.prepared.report.entries.slice(0, 2).map((entry) => entry.reason),
    ).toEqual([
      'conflicting_candidate_metadata',
      'conflicting_candidate_metadata',
    ]);
  },
);

test('preserves provider coverage separately from core exclusions, including empty results', async () => {
  const generate = (request: CandidateRequest) => {
    const set = candidateSet(request, [
      { id: 'invalid', params: { target: 'north', count: 0 } },
    ]);
    return Promise.resolve({
      ...set,
      coverage: {
        generation: 'partial' as const,
        checking: 'partial' as const,
        truncated: true,
        uncheckedScopes: ['unseen area'],
        exclusions: [
          { stage: 'generation' as const, reason: 'unreachable', count: 9 },
        ],
        informationGaps: ['unknown map'],
        capabilityGaps: ['need scanner'],
      },
    });
  };
  const result = await prepareCandidates(
    generationInput(),
    actionRegistry(),
    { generate },
    callControl(),
  );
  if (result.outcome !== 'prepared')
    throw new Error('Expected prepared candidates');
  expect(result.prepared.set.candidates).toEqual([]);
  expect(result.prepared.set.coverage).toMatchObject({
    generation: 'partial',
    checking: 'partial',
    truncated: true,
    uncheckedScopes: ['unseen area'],
    informationGaps: ['unknown map'],
    capabilityGaps: ['need scanner'],
    exclusions: [{ stage: 'checking', reason: 'schema_too_small', count: 1 }],
  });
  expect(result.prepared.providerSet.coverage.exclusions).toEqual([
    { stage: 'generation', reason: 'unreachable', count: 9 },
  ]);
  expect(parseCandidateSet(result.prepared.set)).toEqual(result.prepared.set);
});

test('does not accept actions added while generation is pending', async () => {
  const registry = actionRegistry();
  let release!: (value: CandidateSet) => void;
  const pending = new Promise<CandidateSet>((resolve) => {
    release = resolve;
  });
  const generate = vi.fn<(request: CandidateRequest) => Promise<CandidateSet>>(
    () => pending,
  );
  const result = prepareCandidates(
    generationInput(),
    registry,
    { generate },
    callControl(),
  );
  registry.register(
    defineAction({
      id: 'late',
      version: 1,
      description: 'Late action',
      tags: [],
      expectedEffects: {},
      parameters: z.object({ target: z.string() }),
      check: () => Promise.resolve({ outcome: 'allowed' }),
      execute: () => {
        throw new Error('must not execute');
      },
    }),
  );
  const set = candidateSet(generate.mock.calls[0]![0], [
    { id: 'late', params: { target: 'north' } },
  ]);
  set.candidates[0]!.actionId = 'late';
  release(set);
  const completed = await result;
  if (completed.outcome !== 'prepared')
    throw new Error('Expected prepared candidates');
  expect(
    completed.prepared.request.capabilities.map((capability) => capability.id),
  ).toEqual(['collect']);
  expect(completed.prepared.report.entries[0]?.reason).toBe('unknown_action');
});

test('snapshots provider output before asynchronous normalization and isolates concurrent requests', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const registry = actionRegistry(
    z.object({
      target: z.string().refine(async () => {
        entered();
        await gate;
        return true;
      }),
    }),
  );
  let source: ReturnType<typeof candidateSet> | undefined;
  const first = prepareCandidates(
    generationInput(),
    registry,
    {
      generate: (request) => {
        source = candidateSet(request, [
          { id: 'first', params: { target: 'north' } },
        ]);
        return Promise.resolve(source);
      },
    },
    callControl(),
  );
  await started;
  source!.candidates[0]!.params.target = 'mutated';
  source!.candidates[0]!.paramSources.target!.reference = 'mutated';
  const secondInput = { ...generationInput(1, 5), requestId: 'second' };
  const second = prepareCandidates(
    secondInput,
    registry,
    {
      generate: (request) =>
        Promise.resolve(
          candidateSet(request, [
            { id: 'second', params: { target: 'south' } },
          ]),
        ),
    },
    callControl(),
  );
  release();
  const [one, two] = await Promise.all([first, second]);
  if (one.outcome !== 'prepared' || two.outcome !== 'prepared')
    throw new Error('Expected prepared candidates');
  expect(one.prepared.set.candidates[0]?.params.target).toBe('north');
  expect(one.prepared.set.candidates[0]?.paramSources.target?.reference).toBe(
    'proposal:first/target',
  );
  expect(one.prepared.request.context.effectiveConstraints.maxCount).toBe(2);
  expect(two.prepared.request.context.effectiveConstraints.maxCount).toBe(5);
  expect(two.prepared.set.candidates[0]?.params.target).toBe('south');
});

test('reports thrown provider failures without treating them as an empty or partial answer', async () => {
  const result = await prepareCandidates(
    generationInput(),
    actionRegistry(),
    {
      generate: () => {
        throw new Error('private provider details');
      },
    },
    callControl(),
  );
  expect(result).toMatchObject({
    outcome: 'failed',
    stage: 'generation',
    reason: 'callback_failed',
    issue: null,
    report: { received: null, normalized: 0, remaining: null },
  });
  expect(JSON.stringify(result)).not.toContain('private provider details');
});

test('canonical JSON preserves escaped keys, arrays and deep JSON without recursion', () => {
  expect(
    canonicalJson({
      z: [1, 2],
      'a/b~c': { ['__proto__']: 3, constructor: 'value' },
    }),
  ).toBe('{"a/b~c":{"__proto__":3,"constructor":"value"},"z":[1,2]}');
  let value: JsonValue = 1;
  for (let i = 0; i < 8_000; i += 1) value = [value];
  expect(canonicalJson(value)).toBe(
    '['.repeat(8_000) + '1' + ']'.repeat(8_000),
  );
});
