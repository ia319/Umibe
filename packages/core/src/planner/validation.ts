import type {
  PlannerRequest,
  PlanProposal,
  GoalRevision,
  ProposedGoal,
  ProposedParent,
} from '#internal/planner/contracts';

import type { JsonValue } from '#internal/contracts/json';
import type { GoalRef, PlanRef } from '#internal/contracts/references';
import { ContractError } from '#internal/errors';
import {
  requireInteger,
  requireKeys,
  requireObject,
  requireString,
} from '#internal/validation/fields';
import type { FieldContext } from '#internal/validation/fields';
import { isJsonArray, parseJsonValue } from '#internal/validation/json';
import {
  readGoalRef,
  readObservationRef,
  readPlanRef,
} from '#internal/validation/references';
import { reviseGoalGraph } from '#internal/goal/revisions';

const context: FieldContext = {
  code: 'INVALID_PLAN_PROPOSAL',
  stage: 'plan_proposal',
};

/** A null value disables only that admission limit; graph invariants still apply. */
export interface ProposalLimits {
  readonly maxNewGoals: number | null;
  readonly maxTotalGoals: number | null;
  /** The root is depth one. */
  readonly maxDepth: number | null;
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
  if (
    goals.length === 0 ||
    (limits.maxNewGoals !== null && goals.length > limits.maxNewGoals)
  ) {
    fail('/goals', 'new_goal_limit');
  }
  if (
    limits.maxTotalGoals !== null &&
    request.context.graph.goals.length + goals.length > limits.maxTotalGoals
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
      if (limits.maxDepth !== null && depth >= limits.maxDepth)
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
      if (limits.maxDepth !== null && acceptedDepth + depth > limits.maxDepth)
        fail(`/goals/${index}/parent`, 'depth_limit');
      break;
    }
  }
}

/** Decode fields only; request identity, graph relations and admission limits remain unchecked. */
export function parsePlanProposalShape(input: unknown): PlanProposal {
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
    ...(object.goalOrder === undefined ? [] : ['goalOrder']),
  ];
  const outcome = object.outcome;
  if (
    object.goalOrder !== undefined &&
    (outcome === 'blocked' || outcome === 'claimComplete')
  )
    fail('/goalOrder', 'unexpected_field');
  if (outcome === 'continue' || outcome === 'switch')
    requireKeys(object, [...common, 'nextGoalRef', 'guidance'], context, '');
  else if (outcome === 'decompose')
    requireKeys(
      object,
      [...common, 'goals', 'nextTempId', 'guidance'],
      context,
      '',
    );
  else if (outcome === 'revise' || outcome === 'reconfirm')
    requireKeys(
      object,
      [...common, 'revisions', 'nextGoalRef', 'guidance'],
      context,
      '',
    );
  else if (outcome === 'blocked')
    requireKeys(object, [...common, 'reason'], context, '');
  else if (outcome === 'claimComplete')
    requireKeys(object, [...common, 'goalRef'], context, '');
  else fail('/outcome', 'invalid_outcome');
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
  if (outcome === 'continue' || outcome === 'switch')
    return Object.freeze({
      ...basis,
      outcome,
      nextGoalRef: readGoalRef(object.nextGoalRef, context, '/nextGoalRef'),
      guidance: requireString(object.guidance, context, '/guidance'),
      ...(object.goalOrder === undefined
        ? {}
        : { goalOrder: readGoalOrder(object.goalOrder) }),
    });
  if (outcome === 'decompose') {
    if (!isJsonArray(object.goals)) fail('/goals', 'expected_array');
    let goalOrder: readonly string[] | undefined;
    if (object.goalOrder !== undefined) {
      if (!isJsonArray(object.goalOrder)) fail('/goalOrder', 'expected_array');
      goalOrder = Object.freeze(
        object.goalOrder.map((value, index) =>
          requireString(value, context, `/goalOrder/${index}`),
        ),
      );
    }
    return Object.freeze({
      ...basis,
      outcome,
      goals: Object.freeze(object.goals.map(readGoal)),
      nextTempId: requireString(object.nextTempId, context, '/nextTempId'),
      guidance: requireString(object.guidance, context, '/guidance'),
      ...(goalOrder === undefined ? {} : { goalOrder }),
    });
  }
  if (outcome === 'revise' || outcome === 'reconfirm') {
    if (!isJsonArray(object.revisions)) fail('/revisions', 'expected_array');
    const revisions: readonly GoalRevision[] = Object.freeze(
      object.revisions.map((value, index) => {
        const path = `/revisions/${index}`;
        const item = requireObject(value, context, path);
        requireKeys(
          item,
          ['goalRef', 'parentGoalRef', 'description', 'criteria'],
          context,
          path,
        );
        if (item.criteria === null || item.criteria === undefined)
          fail(`${path}/criteria`, 'missing_criteria');
        return Object.freeze({
          goalRef: readGoalRef(item.goalRef, context, `${path}/goalRef`),
          parentGoalRef: readGoalRef(
            item.parentGoalRef,
            context,
            `${path}/parentGoalRef`,
          ),
          description: requireString(
            item.description,
            context,
            `${path}/description`,
          ),
          criteria: item.criteria,
        });
      }),
    );
    return Object.freeze({
      ...basis,
      outcome,
      revisions,
      nextGoalRef: readGoalRef(object.nextGoalRef, context, '/nextGoalRef'),
      guidance: requireString(object.guidance, context, '/guidance'),
      ...(object.goalOrder === undefined
        ? {}
        : { goalOrder: readGoalOrder(object.goalOrder) }),
    });
  }
  if (outcome === 'blocked')
    return Object.freeze({
      ...basis,
      outcome,
      reason: requireString(object.reason, context, '/reason'),
    });
  return Object.freeze({
    ...basis,
    outcome: 'claimComplete',
    goalRef: readGoalRef(object.goalRef, context, '/goalRef'),
  });
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
    [limits.maxNewGoals, limits.maxTotalGoals, limits.maxDepth].some(
      (limit) => limit !== null && (!Number.isSafeInteger(limit) || limit < 1),
    )
  )
    fail('/limits', 'invalid_limits');
  const proposal = parsePlanProposalShape(input);
  const graph = request.context.graph;
  if (
    proposal.requestId !== request.requestId ||
    proposal.decisionEpoch !== request.decisionEpoch ||
    !sameGoalRef(proposal.rootGoalRef, graph.rootGoalRef) ||
    !sameGoalRef(proposal.currentGoalRef, graph.currentGoalRef) ||
    !samePlanRef(proposal.planRef, request.context.planRef) ||
    proposal.observationRef.id !== request.context.observation.id ||
    proposal.observationRef.revision !== request.context.observation.revision
  )
    fail('', 'stale_request_basis');
  if (proposal.outcome === 'continue' || proposal.outcome === 'switch') {
    acceptedGoal(proposal.nextGoalRef, request, '/nextGoalRef');
    if (
      proposal.outcome === 'continue' &&
      !sameGoalRef(proposal.nextGoalRef, graph.currentGoalRef)
    )
      fail('/nextGoalRef', 'continue_changed_goal');
    if (proposal.goalOrder !== undefined)
      validateGoalOrder(proposal.goalOrder, request);
  } else if (proposal.outcome === 'decompose') {
    validateNewGoals(proposal.goals, request, limits);
    if (!proposal.goals.some((goal) => goal.tempId === proposal.nextTempId))
      fail('/nextTempId', 'missing_next_goal');
    const order = proposal.goalOrder;
    if (
      order !== undefined &&
      (new Set(order).size !== order.length ||
        order.some((id) => !proposal.goals.some((goal) => goal.tempId === id)))
    )
      fail('/goalOrder', 'invalid_goal_order');
  } else if (
    proposal.outcome === 'revise' ||
    proposal.outcome === 'reconfirm'
  ) {
    const revised = reviseGoalGraph(
      graph,
      request.pendingGoals ?? [],
      proposal.revisions,
      proposal.nextGoalRef,
      {
        id: request.context.planRef?.id ?? 'proposed',
        version: (request.context.planRef?.version ?? 0) + 1,
        rootGoalVersion: graph.rootGoalRef.version,
      },
      proposal.outcome,
    );
    for (const goal of revised.graph.goals) {
      let cursor = goal;
      let depth = 1;
      while (cursor.kind === 'child') {
        const parentId = cursor.parentGoalRef.id;
        cursor = revised.graph.goals.find((item) => item.id === parentId)!;
        depth++;
      }
      if (limits.maxDepth !== null && depth > limits.maxDepth)
        fail('/revisions', 'depth_limit');
    }
    if (proposal.goalOrder !== undefined)
      validateGoalOrder(proposal.goalOrder, request, proposal.revisions);
  } else if (
    proposal.outcome === 'claimComplete' &&
    !graph.goalPath.some((ref) => sameGoalRef(ref, proposal.goalRef))
  )
    fail('/goalRef', 'completion_outside_current_path');
  return proposal;
}

function readGoalOrder(value: JsonValue): readonly GoalRef[] {
  if (!isJsonArray(value)) fail('/goalOrder', 'expected_array');
  return Object.freeze(
    value.map((item, index) =>
      readGoalRef(item, context, `/goalOrder/${index}`),
    ),
  );
}

function validateGoalOrder(
  refs: readonly GoalRef[],
  request: PlannerRequest,
  revisions: readonly GoalRevision[] = [],
): void {
  if (new Set(refs.map((ref) => ref.id)).size !== refs.length)
    fail('/goalOrder', 'duplicate_goal_ref');
  for (const ref of refs)
    if (!revisions.some((revision) => sameGoalRef(revision.goalRef, ref)))
      acceptedGoal(ref, request, '/goalOrder');
}
