import type { ActionExecutionContext } from '#internal/contracts/action';
import type { CallControl } from '#internal/contracts/control';
import type { DecisionContext } from '#internal/contracts/context';
import type { ActionResult } from '#internal/contracts/record';
import { parseGoalGraph } from '#internal/validation/goal';
import { parseObservation } from '#internal/validation/observation';

export const control: CallControl = {
  signal: new AbortController().signal,
  deadlineAt: '2026-10-01T01:00:00.000Z',
};

export const decision: DecisionContext = {
  graph: parseGoalGraph({
    runId: 'run-1',
    rootGoalRef: { id: 'root', version: 1 },
    currentGoalRef: { id: 'root', version: 1 },
    goals: [
      {
        kind: 'root',
        id: 'root',
        version: 1,
        runId: 'run-1',
        description: 'Collect three samples',
        criteria: { count: 3 },
        lifecycle: 'inProgress',
        lastAssessment: null,
        parentGoalRef: null,
        acceptedPlanRef: null,
        hardConstraints: [],
        limits: {},
        preferences: [],
      },
    ],
  }),
  planRef: { id: 'plan-1', version: 1, rootGoalVersion: 1 },
  planGuidance: 'Collect nearby samples',
  observation: parseObservation({
    runId: 'run-1',
    id: 'obs-1',
    revision: 1,
    observedAt: '2026-10-01T00:00:00.000Z',
    source: 'test-environment',
    coverage: {
      scope: 'samples',
      completeness: 'complete',
      uncheckedScopes: [],
    },
    data: { samples: { status: 'known', value: 0 } },
  }),
  constraintsVersion: 1,
  effectiveConstraints: { maxDistance: 10 },
  lastActionResult: null,
  recentEvents: [],
};

export const execution: ActionExecutionContext = {
  ...control,
  executionId: 'execution-1',
  decision,
  reportProgress() {},
};

export const result: ActionResult = {
  executionId: 'execution-1',
  outcome: 'succeeded',
  reasonCode: 'sample_collected',
  underlyingSettled: true,
  confirmedEffects: { samples: 1 },
  unresolvedEffects: {},
  progress: {},
  stopCauseEventId: null,
};
