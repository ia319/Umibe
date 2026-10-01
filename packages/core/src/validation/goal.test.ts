import { expect, test } from 'vitest';
import { parseGoalGraph } from './goal.js';

function goalGraphInput() {
  const rootRef = { id: 'root', version: 2 };
  const gatherRef = { id: 'gather', version: 1 };
  const planRef = { id: 'plan', version: 1, rootGoalVersion: 2 };
  const child = (id: string, parentGoalRef: typeof rootRef) => ({
    kind: 'child',
    runId: 'run-1',
    id,
    version: 1,
    description: id,
    criteria: { result: id },
    parentGoalRef,
    acceptedPlanRef: planRef,
    lifecycle: 'pending',
    lastAssessment: null,
  });
  return {
    runId: 'run-1',
    rootGoalRef: rootRef,
    currentGoalRef: { id: 'trade', version: 1 },
    goals: [
      {
        kind: 'root',
        runId: 'run-1',
        ...rootRef,
        description: 'Complete a trade',
        criteria: { traded: true },
        parentGoalRef: null,
        acceptedPlanRef: null,
        lifecycle: 'inProgress',
        lastAssessment: null,
        hardConstraints: [{ allowed: true }],
        limits: { attempts: 10 },
        preferences: [],
      },
      child('gather', rootRef),
      child('trade', gatherRef),
      child('inspect', rootRef),
    ] as const,
  };
}

test('derives the current path from three levels while retaining siblings', () => {
  const input = goalGraphInput();
  const graph = parseGoalGraph(input);
  Object.assign(input.goals[1], { description: 'changed' });

  expect(graph.goalPath).toEqual([
    { id: 'root', version: 2 },
    { id: 'gather', version: 1 },
    { id: 'trade', version: 1 },
  ]);
  expect(graph.goals).toHaveLength(4);
  expect(graph.goals[1]?.description).toBe('gather');
  expect(Object.isFrozen(graph.goals[1])).toBe(true);
});

test('rejects invalid parent relationships and mixed versions', () => {
  const cases = [
    {
      change: (input: ReturnType<typeof goalGraphInput>) =>
        Object.assign(input.goals[2], {
          parentGoalRef: { id: 'missing', version: 1 },
        }),
      path: '/goals/2/parentGoalRef',
      reason: 'missing_parent',
    },
    {
      change: (input: ReturnType<typeof goalGraphInput>) =>
        Object.assign(input.goals[2], {
          parentGoalRef: { id: 'gather', version: 2 },
        }),
      path: '/goals/2/parentGoalRef/version',
      reason: 'stale_parent_version',
    },
    {
      change: (input: ReturnType<typeof goalGraphInput>) =>
        Object.assign(input.goals[3], { id: 'gather' }),
      path: '/goals/3/id',
      reason: 'duplicate_goal_id',
    },
    {
      change: (input: ReturnType<typeof goalGraphInput>) =>
        Object.assign(input.goals[1], { runId: 'other-run' }),
      path: '/goals/1/runId',
      reason: 'cross_run_goal',
    },
    {
      change: (input: ReturnType<typeof goalGraphInput>) =>
        Object.assign(input.goals[1], {
          parentGoalRef: { id: 'trade', version: 1 },
        }),
      path: '/goals/1/parentGoalRef',
      reason: 'cycle',
    },
    {
      change: (input: ReturnType<typeof goalGraphInput>) =>
        Object.assign(input.goals[2], {
          acceptedPlanRef: { id: 'plan', version: 1, rootGoalVersion: 1 },
        }),
      path: '/goals/2/acceptedPlanRef/rootGoalVersion',
      reason: 'stale_root_version',
    },
  ];

  for (const { change, path, reason } of cases) {
    const input = goalGraphInput();
    change(input);
    expect(() => parseGoalGraph(input)).toThrowError(
      expect.objectContaining({ code: 'INVALID_GOAL_GRAPH', path, reason }),
    );
  }
});

test('requires independent evidence before a goal can be succeeded', () => {
  const input = goalGraphInput();
  Object.assign(input.goals[2], { lifecycle: 'succeeded' });
  expect(() => parseGoalGraph(input)).toThrowError(
    expect.objectContaining({ reason: 'success_without_verification' }),
  );

  const evidence = {
    source: 'application',
    observationPaths: ['tradeCompleted'],
    executionIds: ['trade-1'],
    details: { tradeId: 'confirmed' },
  };
  Object.assign(input.goals[2], {
    lastAssessment: {
      goalRef: { id: 'trade', version: 1 },
      observationRef: { id: 'observation', revision: 0 },
      outcome: 'passed',
      evidence,
      reason: null,
    },
  });
  const graph = parseGoalGraph(input);
  expect(graph.goals[2]?.lifecycle).toBe('succeeded');
  expect(graph.goals[0]?.lifecycle).toBe('inProgress');

  Object.assign(evidence, { observationPaths: [], executionIds: [] });
  expect(() => parseGoalGraph(input)).toThrowError(
    expect.objectContaining({ reason: 'evidence_without_reference' }),
  );
});
