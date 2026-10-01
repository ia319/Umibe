import { expect, test } from 'vitest';
import type { PlannerRequest } from '../contracts/adapters.js';
import { parseGoalGraph } from './goal.js';
import { parseObservation } from './observation.js';
import { parsePlanProposal } from './planning.js';

function request(): PlannerRequest {
  const rootGoalRef = { id: 'root', version: 2 };
  const currentGoalRef = { id: 'search', version: 1 };
  const graph = parseGoalGraph({
    runId: 'run-1',
    rootGoalRef,
    currentGoalRef,
    goals: [
      {
        kind: 'root',
        runId: 'run-1',
        ...rootGoalRef,
        description: 'Trade with a villager',
        criteria: { traded: true },
        lifecycle: 'inProgress',
        lastAssessment: null,
        parentGoalRef: null,
        acceptedPlanRef: null,
        hardConstraints: [],
        limits: {},
        preferences: [],
      },
      {
        kind: 'child',
        runId: 'run-1',
        ...currentGoalRef,
        description: 'Find a village',
        criteria: { villageSeen: true },
        lifecycle: 'inProgress',
        lastAssessment: null,
        parentGoalRef: rootGoalRef,
        acceptedPlanRef: { id: 'plan-1', version: 1, rootGoalVersion: 2 },
      },
    ],
  });
  const observation = parseObservation({
    runId: 'run-1',
    id: 'obs-1',
    revision: 3,
    observedAt: '2026-09-29T00:00:00.000Z',
    source: 'test',
    coverage: {
      scope: 'nearby',
      completeness: 'partial',
      uncheckedScopes: ['north'],
    },
    data: { villageSeen: { status: 'absent' } },
  });
  return {
    requestId: 'plan-request-1',
    decisionEpoch: 4,
    context: {
      graph,
      observation,
      planRef: { id: 'plan-1', version: 1, rootGoalVersion: 2 },
      planGuidance: 'Search nearby land',
      constraintsVersion: 1,
      effectiveConstraints: {},
      lastActionResult: null,
      recentEvents: [],
    },
    capabilities: [],
    trigger: { kind: 'branchExhausted', goalRef: currentGoalRef },
  };
}

function basis(input: PlannerRequest) {
  return {
    requestId: input.requestId,
    decisionEpoch: input.decisionEpoch,
    rootGoalRef: input.context.graph.rootGoalRef,
    currentGoalRef: input.context.graph.currentGoalRef,
    planRef: input.context.planRef,
    observationRef: {
      id: input.context.observation.id,
      revision: input.context.observation.revision,
    },
  };
}

test('accepts a nested proposal and leaves accepted graph untouched', () => {
  const input = request();
  const proposal = parsePlanProposal(
    {
      ...basis(input),
      outcome: 'decompose',
      nextTempId: 'trade',
      guidance: 'Approach then trade',
      goals: [
        {
          tempId: 'approach',
          parent: {
            kind: 'accepted',
            goalRef: input.context.graph.currentGoalRef,
          },
          description: 'Approach villager',
          criteria: { near: true },
        },
        {
          tempId: 'trade',
          parent: { kind: 'proposed', tempId: 'approach' },
          description: 'Trade',
          criteria: { traded: true },
        },
      ],
    },
    input,
    { maxNewGoals: 2, maxTotalGoals: 4, maxDepth: 4 },
  );
  expect(proposal.outcome).toBe('decompose');
  expect(input.context.graph.goals).toHaveLength(2);
  expect(Object.isFrozen(proposal)).toBe(true);
});

test('rejects stale basis, cycles, missing parents and excess depth', () => {
  const input = request();
  const limits = { maxNewGoals: 2, maxTotalGoals: 4, maxDepth: 4 };
  const proposal = {
    ...basis(input),
    outcome: 'decompose',
    nextTempId: 'a',
    guidance: 'Explore',
    goals: [
      {
        tempId: 'a',
        parent: { kind: 'proposed', tempId: 'b' },
        description: 'A',
        criteria: { done: true },
      },
      {
        tempId: 'b',
        parent: { kind: 'proposed', tempId: 'a' },
        description: 'B',
        criteria: { done: true },
      },
    ],
  };
  expect(() =>
    parsePlanProposal({ ...proposal, decisionEpoch: 3 }, input, limits),
  ).toThrowError(expect.objectContaining({ reason: 'stale_request_basis' }));
  expect(() => parsePlanProposal(proposal, input, limits)).toThrowError(
    expect.objectContaining({ reason: 'cycle' }),
  );
  proposal.goals[1]!.parent.tempId = 'missing';
  expect(() => parsePlanProposal(proposal, input, limits)).toThrowError(
    expect.objectContaining({ reason: 'missing_proposed_parent' }),
  );
  const tooDeep = {
    ...basis(input),
    outcome: 'decompose',
    nextTempId: 'b',
    guidance: 'Explore',
    goals: [
      {
        tempId: 'a',
        parent: {
          kind: 'accepted',
          goalRef: input.context.graph.currentGoalRef,
        },
        description: 'A',
        criteria: { done: true },
      },
      {
        tempId: 'b',
        parent: { kind: 'proposed', tempId: 'a' },
        description: 'B',
        criteria: { done: true },
      },
    ],
  };
  expect(() =>
    parsePlanProposal(tooDeep, input, { ...limits, maxDepth: 3 }),
  ).toThrowError(expect.objectContaining({ reason: 'depth_limit' }));
  expect(() =>
    parsePlanProposal(tooDeep, input, { ...limits, maxTotalGoals: 3 }),
  ).toThrowError(expect.objectContaining({ reason: 'total_goal_limit' }));
});

test('completion advice cannot substitute for verification', () => {
  const input = request();
  const proposal = parsePlanProposal(
    {
      ...basis(input),
      outcome: 'claimComplete',
      goalRef: input.context.graph.rootGoalRef,
    },
    input,
    { maxNewGoals: 2, maxTotalGoals: 4, maxDepth: 4 },
  );
  expect(proposal.outcome).toBe('claimComplete');
  expect(input.context.graph.goals[0]?.lifecycle).toBe('inProgress');
});
