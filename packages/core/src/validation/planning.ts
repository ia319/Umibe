import type { PlannerRequest } from '#internal/contracts/adapters';
import type {
  PlanProposal,
  ProposedGoal,
  ProposedParent,
} from '#internal/contracts/planning';
import type { JsonValue } from '#internal/contracts/json';
import type { GoalRef, PlanRef } from '#internal/contracts/references';
import { ContractError } from '#internal/errors';
import {
  requireInteger,
  requireKeys,
  requireObject,
  requireString,
} from './fields.js';
import type { FieldContext } from './fields.js';
import { isJsonArray, parseJsonValue } from './json.js';
import { readGoalRef, readObservationRef, readPlanRef } from './references.js';

const context: FieldContext = {
  code: 'INVALID_PLAN_PROPOSAL',
  stage: 'plan_proposal',
};

export interface ProposalLimits {
  readonly maxNewGoals: number;
  readonly maxTotalGoals: number;
  /** The root is depth one. */
  readonly maxDepth: number;
}

function fail(path: string, reason: string): never {
  throw new ContractError(context.code, context.stage, path, reason);
}

function sameGoalRef(left: GoalRef, right: GoalRef): boolean {
  return left.id === right.id && left.version === right.version;
}

function samePlanRef(left: PlanRef | null, right: PlanRef | null): boolean {
  return left === null
    ? right === null
    : right !== null &&
        left.id === right.id &&
        left.version === right.version &&
        left.rootGoalVersion === right.rootGoalVersion;
}

function acceptedGoal(ref: GoalRef, request: PlannerRequest, path: string) {
  const goal = request.context.graph.goals.find((item) => item.id === ref.id);
  if (goal === undefined || !sameGoalRef(goal, ref))
    fail(path, 'missing_or_stale_goal');
  if (goal.lifecycle !== 'pending' && goal.lifecycle !== 'inProgress') {
    fail(path, 'inactive_goal');
  }
  return goal;
}

function readParent(
  value: JsonValue | undefined,
  path: string,
): ProposedParent {
  const object = requireObject(value, context, path);
  if (object.kind === 'accepted') {
    requireKeys(object, ['kind', 'goalRef'], context, path);
    return Object.freeze({
      kind: 'accepted',
      goalRef: readGoalRef(object.goalRef, context, `${path}/goalRef`),
    });
  }
  if (object.kind === 'proposed') {
    requireKeys(object, ['kind', 'tempId'], context, path);
    return Object.freeze({
      kind: 'proposed',
      tempId: requireString(object.tempId, context, `${path}/tempId`),
    });
  }
  return fail(`${path}/kind`, 'invalid_parent_kind');
}

function readGoal(value: JsonValue, index: number): ProposedGoal {
  const path = `/goals/${index}`;
  const object = requireObject(value, context, path);
  requireKeys(
    object,
    ['tempId', 'parent', 'description', 'criteria'],
    context,
    path,
  );
  if (object.criteria === null || object.criteria === undefined) {
    fail(`${path}/criteria`, 'missing_criteria');
  }
  return Object.freeze({
    tempId: requireString(object.tempId, context, `${path}/tempId`),
    parent: readParent(object.parent, `${path}/parent`),
    description: requireString(
      object.description,
      context,
      `${path}/description`,
    ),
    criteria: object.criteria,
  });
}

function validateNewGoals(
  goals: readonly ProposedGoal[],
  request: PlannerRequest,
  limits: ProposalLimits,
): void {
  if (goals.length === 0 || goals.length > limits.maxNewGoals) {
    fail('/goals', 'new_goal_limit');
  }
  if (
    request.context.graph.goals.length + goals.length >
    limits.maxTotalGoals
  ) {
    fail('/goals', 'total_goal_limit');
  }
  const proposed = new Map<string, ProposedGoal>();
  for (const [index, goal] of goals.entries()) {
    if (proposed.has(goal.tempId))
      fail(`/goals/${index}/tempId`, 'duplicate_temp_id');
    proposed.set(goal.tempId, goal);
  }
  const graph = request.context.graph;
  for (const [index, goal] of goals.entries()) {
    let cursor = goal;
    const visited = new Set<string>();
    let depth = 0;
    while (true) {
      if (visited.has(cursor.tempId)) fail(`/goals/${index}/parent`, 'cycle');
      visited.add(cursor.tempId);
      depth += 1;
      if (depth >= limits.maxDepth)
        fail(`/goals/${index}/parent`, 'depth_limit');
      if (cursor.parent.kind === 'proposed') {
        const parent = proposed.get(cursor.parent.tempId);
        if (parent === undefined)
          fail(`/goals/${index}/parent`, 'missing_proposed_parent');
        cursor = parent;
        continue;
      }
      const parentRef = cursor.parent.goalRef;
      const parent = acceptedGoal(
        parentRef,
        request,
        `/goals/${index}/parent/goalRef`,
      );
      if (!graph.goalPath.some((ref) => sameGoalRef(ref, parentRef))) {
        fail(`/goals/${index}/parent/goalRef`, 'parent_outside_current_path');
      }
      let acceptedDepth = 1;
      let ancestor = parent;
      while (ancestor.kind === 'child') {
        const ancestorParentRef = ancestor.parentGoalRef;
        const next = graph.goals.find(
          (item) => item.id === ancestorParentRef.id,
        );
        if (next === undefined)
          fail(`/goals/${index}/parent`, 'missing_accepted_parent');
        ancestor = next;
        acceptedDepth += 1;
      }
      if (acceptedDepth + depth > limits.maxDepth)
        fail(`/goals/${index}/parent`, 'depth_limit');
      break;
    }
  }
}

/** Reject a stale or structurally invalid planner answer before any graph mutation.
 * @param input - Untrusted planner output.
 * @param request - The exact request that produced the answer.
 * @param limits - Application-owned admission limits.
 * @returns A detached, frozen proposal; it is still not an accepted plan.
 * @throws ContractError when the basis, relation or limits are invalid.
 */
export function parsePlanProposal(
  input: unknown,
  request: PlannerRequest,
  limits: ProposalLimits,
): PlanProposal {
  if (
    !Number.isSafeInteger(limits.maxNewGoals) ||
    limits.maxNewGoals < 1 ||
    !Number.isSafeInteger(limits.maxTotalGoals) ||
    limits.maxTotalGoals < 1 ||
    !Number.isSafeInteger(limits.maxDepth) ||
    limits.maxDepth < 1
  )
    fail('/limits', 'invalid_limits');
  const object = requireObject(
    parseJsonValue(input, context.stage),
    context,
    '',
  );
  const common = [
    'requestId',
    'decisionEpoch',
    'rootGoalRef',
    'currentGoalRef',
    'planRef',
    'observationRef',
    'outcome',
  ];
  const outcome = object.outcome;
  if (outcome === 'continue' || outcome === 'switch') {
    requireKeys(object, [...common, 'nextGoalRef', 'guidance'], context, '');
  } else if (outcome === 'decompose') {
    requireKeys(
      object,
      [...common, 'goals', 'nextTempId', 'guidance'],
      context,
      '',
    );
  } else if (outcome === 'blocked') {
    requireKeys(object, [...common, 'reason'], context, '');
  } else if (outcome === 'claimComplete') {
    requireKeys(object, [...common, 'goalRef'], context, '');
  } else {
    fail('/outcome', 'invalid_outcome');
  }
  const basis = {
    requestId: requireString(object.requestId, context, '/requestId'),
    decisionEpoch: requireInteger(
      object.decisionEpoch,
      0,
      context,
      '/decisionEpoch',
    ),
    rootGoalRef: readGoalRef(object.rootGoalRef, context, '/rootGoalRef'),
    currentGoalRef: readGoalRef(
      object.currentGoalRef,
      context,
      '/currentGoalRef',
    ),
    planRef:
      object.planRef === null
        ? null
        : readPlanRef(object.planRef, context, '/planRef'),
    observationRef: readObservationRef(
      object.observationRef,
      context,
      '/observationRef',
    ),
  };
  const graph = request.context.graph;
  if (
    basis.requestId !== request.requestId ||
    basis.decisionEpoch !== request.decisionEpoch ||
    !sameGoalRef(basis.rootGoalRef, graph.rootGoalRef) ||
    !sameGoalRef(basis.currentGoalRef, graph.currentGoalRef) ||
    !samePlanRef(basis.planRef, request.context.planRef) ||
    basis.observationRef.id !== request.context.observation.id ||
    basis.observationRef.revision !== request.context.observation.revision
  )
    fail('', 'stale_request_basis');
  if (outcome === 'continue' || outcome === 'switch') {
    const nextGoalRef = readGoalRef(
      object.nextGoalRef,
      context,
      '/nextGoalRef',
    );
    acceptedGoal(nextGoalRef, request, '/nextGoalRef');
    if (
      outcome === 'continue' &&
      !sameGoalRef(nextGoalRef, graph.currentGoalRef)
    ) {
      fail('/nextGoalRef', 'continue_changed_goal');
    }
    return Object.freeze({
      ...basis,
      outcome,
      nextGoalRef,
      guidance: requireString(object.guidance, context, '/guidance'),
    });
  }
  if (outcome === 'decompose') {
    if (!isJsonArray(object.goals)) fail('/goals', 'expected_array');
    const goals = Object.freeze(object.goals.map(readGoal));
    validateNewGoals(goals, request, limits);
    const nextTempId = requireString(object.nextTempId, context, '/nextTempId');
    if (!goals.some((goal) => goal.tempId === nextTempId)) {
      fail('/nextTempId', 'missing_next_goal');
    }
    return Object.freeze({
      ...basis,
      outcome,
      goals,
      nextTempId,
      guidance: requireString(object.guidance, context, '/guidance'),
    });
  }
  if (outcome === 'blocked') {
    return Object.freeze({
      ...basis,
      outcome,
      reason: requireString(object.reason, context, '/reason'),
    });
  }
  const goalRef = readGoalRef(object.goalRef, context, '/goalRef');
  if (!graph.goalPath.some((ref) => sameGoalRef(ref, goalRef))) {
    fail('/goalRef', 'completion_outside_current_path');
  }
  return Object.freeze({ ...basis, outcome: 'claimComplete', goalRef });
}
