import { randomUUID } from 'node:crypto';
import type { ChildGoalRecord } from '#internal/contracts/goal';
import { captureDecisionRequest } from '#internal/candidate/context';
import { requireKeys, requireObject } from '#internal/validation/fields';
import { parseJsonValue } from '#internal/validation/json';
import { parseGoalGraph } from '#internal/validation/goal';
import { ContractError } from '#internal/errors';
import { captureLimits } from './limits.js';
import type { SessionState } from './session.js';

/** Validate application-owned changes before any paused state is replaced. */
export function prepareResume(
  state: SessionState,
  input: unknown,
  eventId: string,
): SessionState {
  const validation = { code: 'INVALID_RUN_CONTROL', stage: 'resume' } as const;
  const raw = requireObject(parseJsonValue(input, 'resume'), validation, '');
  const keys = ['context', 'effectiveConstraints', 'goal', 'limits'].filter(
    (key) => Object.hasOwn(raw, key),
  );
  requireKeys(raw, keys, validation, '');
  const context = state.decision.context;
  let graph = context.graph;
  let goals = state.goals;
  let limits = state.limits;
  if (raw.limits !== undefined) {
    const supplied = requireObject(raw.limits, validation, '/limits');
    for (const key of Object.keys(supplied))
      if (
        ![
          'maxActionAttempts',
          'maxModelAttempts',
          'maxGoalDepth',
          'maxSubgoals',
          'maxNoProgress',
          'maxRecoveryAttempts',
        ].includes(key)
      )
        throw new ContractError(
          validation.code,
          validation.stage,
          `/limits/${key}`,
          'immutable_limit',
        );
    limits = captureLimits({ ...limits, ...supplied });
    for (const key of [
      'maxActionAttempts',
      'maxModelAttempts',
      'maxGoalDepth',
      'maxSubgoals',
      'maxNoProgress',
      'maxRecoveryAttempts',
    ] as const)
      if (limits[key] < state.limits[key])
        throw new ContractError(
          validation.code,
          validation.stage,
          `/limits/${key}`,
          'decreased_limit',
        );
  }
  const changedRoot = raw.goal !== undefined;
  if (changedRoot) {
    const root = requireObject(raw.goal, validation, '/goal');
    requireKeys(
      root,
      [
        'id',
        'version',
        'description',
        'criteria',
        'hardConstraints',
        'limits',
        'preferences',
      ],
      validation,
      '/goal',
    );
    if (
      root.id !== graph.rootGoalRef.id ||
      root.version !== graph.rootGoalRef.version + 1
    )
      throw new ContractError(
        validation.code,
        validation.stage,
        '/goal',
        'invalid_root_revision',
      );
    if (raw.effectiveConstraints === undefined)
      throw new ContractError(
        validation.code,
        validation.stage,
        '/effectiveConstraints',
        'missing_effective_constraints',
      );
    graph = parseGoalGraph({
      runId: graph.runId,
      rootGoalRef: { id: root.id, version: root.version },
      currentGoalRef: { id: root.id, version: root.version },
      goals: [
        {
          ...root,
          kind: 'root',
          runId: graph.runId,
          parentGoalRef: null,
          acceptedPlanRef: null,
          lifecycle: 'inProgress',
          lastAssessment: null,
        },
      ],
    });
    const pending = new Map(goals.pending.map((goal) => [goal.id, goal]));
    for (const goal of context.graph.goals)
      if (goal.kind === 'child')
        pending.set(goal.id, {
          ...goal,
          lifecycle: 'superseded',
          lastAssessment: null,
        } satisfies ChildGoalRecord);
    goals = { ...goals, pending: [...pending.values()], order: [] };
  }
  const decision = captureDecisionRequest({
    requestId: randomUUID(),
    decisionEpoch: state.decision.decisionEpoch + 1,
    context: {
      ...context,
      graph,
      applicationContext:
        raw.context === undefined
          ? (context.applicationContext ?? {})
          : {
              ...context.applicationContext,
              ...requireObject(raw.context, validation, '/context'),
            },
      effectiveConstraints:
        raw.effectiveConstraints === undefined
          ? context.effectiveConstraints
          : requireObject(
              raw.effectiveConstraints,
              validation,
              '/effectiveConstraints',
            ),
      constraintsVersion:
        context.constraintsVersion +
        (raw.effectiveConstraints === undefined ? 0 : 1),
      planRef: changedRoot ? null : context.planRef,
      planGuidance: changedRoot ? null : context.planGuidance,
    },
  });
  return {
    ...state,
    decision,
    goals,
    limits,
    control: { ...state.control, rootGoalRef: graph.rootGoalRef },
    progress: changedRoot ? [] : state.progress,
    scheduling: {
      ...state.scheduling,
      planning: changedRoot
        ? { kind: 'initial', assessment: 'notYet' }
        : raw.context !== undefined || raw.effectiveConstraints !== undefined
          ? { kind: 'planInvalidated', eventId }
          : state.scheduling.planning,
      recoveryAttempts: changedRoot ? 0 : state.scheduling.recoveryAttempts,
      selectionCause: 'resumed',
      lastSelectionBasis: null,
    },
  };
}
