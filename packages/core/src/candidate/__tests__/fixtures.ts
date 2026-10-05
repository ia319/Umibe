import { z } from 'zod';
import { ActionRegistry, defineAction } from '#internal/action/registry';
import type { ActionDefinition } from '#internal/contracts/action';
import type { CallControl } from '#internal/contracts/control';
import type { CandidateRequest } from '#internal/contracts/adapters';
import type { CandidateSet } from '#internal/contracts/candidate';
import type { CandidateGenerationInput } from '#internal/contracts/candidate-processing';
import type { JsonValue } from '#internal/contracts/json';
import { parseGoalGraph } from '#internal/validation/goal';
import { parseObservation } from '#internal/validation/observation';
import { prepareCandidates } from '../prepare.js';
import { checkCandidates } from '../check.js';

export function generationInput(
  rootVersion = 1,
  count = 2,
): CandidateGenerationInput {
  const rootGoalRef = { id: 'root', version: rootVersion };
  const areaRef = { id: 'area', version: 1 };
  const currentGoalRef = { id: 'collect', version: 1 };
  const planRef = { id: 'plan', version: 1, rootGoalVersion: rootVersion };
  const graph = parseGoalGraph({
    runId: 'run',
    rootGoalRef,
    currentGoalRef,
    goals: [
      {
        ...rootGoalRef,
        kind: 'root',
        runId: 'run',
        description: 'Collect samples',
        criteria: { count },
        lifecycle: 'inProgress',
        lastAssessment: null,
        parentGoalRef: null,
        acceptedPlanRef: null,
        hardConstraints: [{ protected: true }],
        limits: { actions: 10 },
        preferences: [],
      },
      {
        ...areaRef,
        kind: 'child',
        runId: 'run',
        description: 'Search the assigned area',
        criteria: { area: 'north' },
        lifecycle: 'inProgress',
        lastAssessment: null,
        parentGoalRef: rootGoalRef,
        acceptedPlanRef: planRef,
      },
      {
        ...currentGoalRef,
        kind: 'child',
        runId: 'run',
        description: 'Collect nearby samples',
        criteria: { count },
        lifecycle: 'pending',
        lastAssessment: null,
        parentGoalRef: areaRef,
        acceptedPlanRef: planRef,
      },
      {
        id: 'old-area',
        version: 1,
        kind: 'child',
        runId: 'run',
        description: 'Abandoned area',
        criteria: { area: 'south' },
        lifecycle: 'cancelled',
        lastAssessment: null,
        parentGoalRef: rootGoalRef,
        acceptedPlanRef: planRef,
      },
    ],
  });
  return {
    requestId: 'request',
    decisionEpoch: 3,
    context: {
      graph,
      planRef,
      planGuidance: 'Use nearby samples',
      observation: parseObservation({
        runId: 'run',
        id: 'observation',
        revision: 4,
        observedAt: '2026-10-02T00:00:00.000Z',
        source: 'test',
        coverage: {
          scope: 'nearby',
          completeness: 'complete',
          uncheckedScopes: [],
        },
        data: {
          target: { status: 'known', value: 'north' },
          available: { status: 'known', value: true },
        },
      }),
      constraintsVersion: 2,
      effectiveConstraints: { maxCount: count, protected: ['south'] },
      lastActionResult: null,
      recentEvents: [],
    },
  };
}

export function callControl(
  signal = new AbortController().signal,
): CallControl {
  return { signal, deadlineAt: new Date(Date.now() + 60_000).toISOString() };
}

export function candidateSet(
  request: CandidateRequest,
  proposals: readonly { id: string; params: Record<string, JsonValue> }[],
) {
  const { context } = request;
  if (context.planRef === null)
    throw new Error('A valid plan is required by this fixture');
  const basis = {
    id: 'provider-set',
    runId: context.graph.runId,
    rootGoalRef: context.graph.rootGoalRef,
    currentGoalRef: context.graph.currentGoalRef,
    goalPath: context.graph.goalPath,
    goalPathRef: 'provider-path',
    planRef: context.planRef,
    observationRef: {
      id: context.observation.id,
      revision: context.observation.revision,
    },
    constraintsVersion: context.constraintsVersion,
    coverage: {
      generation: 'complete',
      checking: 'complete',
      uncheckedScopes: [],
      truncated: false,
      exclusions: [],
      informationGaps: [],
      capabilityGaps: [],
    } satisfies CandidateSet['coverage'],
  };
  return {
    ...basis,
    candidates: proposals.map((proposal) => ({
      ...proposal,
      candidateSetId: basis.id,
      actionId: 'collect',
      actionVersion: 1,
      paramSources: Object.fromEntries(
        Object.keys(proposal.params).map((key) => [
          key,
          {
            kind: 'application' as const,
            reference: `proposal:${proposal.id}/${key}`,
          },
        ]),
      ),
      description: `Collect ${proposal.id}`,
      expectedEffects: { samples: true },
      cost: null,
      risk: null,
      source: 'fixture',
      goalRef: basis.currentGoalRef,
      goalPathRef: basis.goalPathRef,
      planRef: basis.planRef,
      observationRef: basis.observationRef,
      constraintsVersion: basis.constraintsVersion,
    })),
  };
}

export function actionRegistry(
  parameters: z.ZodObject = z.strictObject({
    target: z.string().min(1),
    count: z.number().int().min(1).default(1),
  }),
  check: ActionDefinition<z.ZodObject>['check'] = () =>
    Promise.resolve({ outcome: 'allowed' }),
): ActionRegistry {
  return new ActionRegistry([
    defineAction({
      id: 'collect',
      version: 1,
      description: 'Collect samples',
      tags: ['samples'],
      expectedEffects: { samples: true },
      parameters,
      check,
      execute: () => {
        throw new Error('Candidate processing must not execute actions');
      },
    }),
  ]);
}

export async function checkedBatch(
  registry: ActionRegistry,
  targets: readonly string[],
) {
  const preparation = await prepareCandidates(
    generationInput(),
    registry,
    {
      generate: (request) =>
        Promise.resolve(
          candidateSet(
            request,
            targets.map((target, index) => ({
              id: `proposal-${index}`,
              params: { target },
            })),
          ),
        ),
    },
    callControl(),
  );
  if (preparation.outcome !== 'prepared')
    throw new Error('Expected prepared fixture');
  const checking = await checkCandidates(preparation.prepared, callControl());
  if (checking.outcome !== 'checked')
    throw new Error('Expected checked fixture');
  return checking.checked;
}
