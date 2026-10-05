import { randomUUID } from 'node:crypto';
import type {
  ChildGoalRecord,
  GoalAssessment,
  GoalGraphSnapshot,
  GoalRecord,
} from '#internal/contracts/goal';
import type { DecisionContext } from '#internal/contracts/context';
import type { JsonValue } from '#internal/contracts/json';
import type { PlanProposal } from '#internal/planner/contracts';
import type { GoalRef, PlanRef } from '#internal/contracts/references';
import { reviseGoalGraph } from '#internal/goal/revisions';
import { parseGoalGraph } from '#internal/validation/goal';
import { ContractError } from '#internal/errors';

export interface GoalState {
  readonly created: number;
  readonly pending: readonly ChildGoalRecord[];
  readonly order: readonly GoalRef[];
}

/** An accepted assessment may cite only known observations and supplied settled effects. */
export function assertAssessmentEvidence(
  assessment: GoalAssessment,
  context: DecisionContext,
): void {
  const evidence = assessment.evidence;
  if (evidence === null) return;
  const invalid = () => {
    throw new ContractError(
      'INVALID_RUN_CONTROL',
      'verification',
      '/evidence',
      'unbound_evidence',
    );
  };
  for (const path of evidence.observationPaths) {
    if (!path.startsWith('/') || /~(?![01])/u.test(path)) invalid();
    const keys = path
      .slice(1)
      .split('/')
      .map((key) => key.replaceAll('~1', '/').replaceAll('~0', '~'));
    const fact = context.observation.data[keys.shift()!];
    if (fact?.status !== 'known') {
      invalid();
      continue;
    }
    let value: JsonValue | undefined = fact.value;
    for (const key of keys)
      value =
        value !== null && typeof value === 'object' && Object.hasOwn(value, key)
          ? (Reflect.get(value, key) as JsonValue)
          : undefined;
    if (value === undefined) invalid();
  }
  for (const id of evidence.executionIds)
    if (
      !(
        context.runtime?.recentResults ??
        (context.lastActionResult === null ? [] : [context.lastActionResult])
      ).some(
        (result) => result.executionId === id && result.outcome !== 'unknown',
      )
    )
      invalid();
}

/** Select one active path while retaining sibling assessments and pending work. */
export function focusGoal(
  graph: GoalGraphSnapshot,
  next: GoalRef,
): GoalGraphSnapshot {
  const path = parseGoalGraph({
    runId: graph.runId,
    rootGoalRef: graph.rootGoalRef,
    currentGoalRef: next,
    goals: graph.goals,
  });
  const active = new Set(path.goalPath.map((ref) => ref.id));
  if (
    path.goals.some(
      (goal) =>
        active.has(goal.id) &&
        goal.lifecycle !== 'pending' &&
        goal.lifecycle !== 'inProgress',
    )
  )
    throw new ContractError(
      'INVALID_PLAN_PROPOSAL',
      'goal_focus',
      '/nextGoalRef',
      'inactive_goal_path',
    );
  return parseGoalGraph({
    runId: graph.runId,
    rootGoalRef: graph.rootGoalRef,
    currentGoalRef: next,
    goals: graph.goals.map((goal) =>
      active.has(goal.id)
        ? { ...goal, lifecycle: 'inProgress' }
        : goal.lifecycle === 'inProgress'
          ? { ...goal, lifecycle: 'pending' }
          : goal,
    ),
  });
}

/** Build the complete candidate graph before verifier support or state admission. */
export function preparePlan(
  graph: GoalGraphSnapshot,
  state: GoalState,
  proposal: Exclude<PlanProposal, { outcome: 'blocked' | 'claimComplete' }>,
  planRef: PlanRef,
  maxSubgoals: number,
): {
  graph: GoalGraphSnapshot;
  state: GoalState;
  changed: readonly GoalRecord[];
} {
  let nextGraph = graph;
  let pending = state.pending;
  let created = state.created;
  let changed: readonly GoalRecord[] = [];
  let order = state.order;
  if (proposal.outcome === 'decompose') {
    created += proposal.goals.length;
    if (created > maxSubgoals)
      throw new ContractError(
        'INVALID_PLAN_PROPOSAL',
        'goal_admission',
        '/goals',
        'cumulative_goal_limit',
      );
    const refs = new Map(
      proposal.goals.map((goal) => [
        goal.tempId,
        { id: randomUUID(), version: 1 },
      ]),
    );
    changed = proposal.goals.map((goal): ChildGoalRecord => ({
      kind: 'child',
      runId: graph.runId,
      ...refs.get(goal.tempId)!,
      description: goal.description,
      criteria: goal.criteria,
      parentGoalRef:
        goal.parent.kind === 'accepted'
          ? goal.parent.goalRef
          : refs.get(goal.parent.tempId)!,
      acceptedPlanRef: planRef,
      lifecycle: 'pending',
      lastAssessment: null,
    }));
    nextGraph = parseGoalGraph({
      runId: graph.runId,
      rootGoalRef: graph.rootGoalRef,
      currentGoalRef: refs.get(proposal.nextTempId)!,
      goals: [...graph.goals, ...changed],
    });
    order = [
      ...(proposal.goalOrder ?? proposal.goals.map((goal) => goal.tempId)).map(
        (id) => refs.get(id)!,
      ),
      ...order,
    ];
  } else if (
    proposal.outcome === 'revise' ||
    proposal.outcome === 'reconfirm'
  ) {
    const revised = reviseGoalGraph(
      graph,
      pending,
      proposal.revisions,
      proposal.nextGoalRef,
      planRef,
      proposal.outcome,
    );
    nextGraph = revised.graph;
    pending = revised.pending;
    changed = revised.changed;
    order = [
      ...(proposal.goalOrder ?? proposal.revisions.map((item) => item.goalRef)),
      ...order,
    ].map((ref) => {
      const replacement = changed.find((goal) => goal.id === ref.id);
      return replacement
        ? { id: replacement.id, version: replacement.version }
        : ref;
    });
  } else {
    nextGraph = parseGoalGraph({
      runId: graph.runId,
      rootGoalRef: graph.rootGoalRef,
      currentGoalRef: proposal.nextGoalRef,
      goals: graph.goals,
    });
    order = proposal.goalOrder ?? order;
  }
  nextGraph = focusGoal(nextGraph, nextGraph.currentGoalRef);
  const path = new Set(nextGraph.goalPath.map((ref) => ref.id));
  order = order.filter(
    (ref, index) =>
      !path.has(ref.id) &&
      order.findIndex((item) => item.id === ref.id) === index &&
      nextGraph.goals.some(
        (goal) =>
          goal.id === ref.id &&
          goal.version === ref.version &&
          (goal.lifecycle === 'pending' || goal.lifecycle === 'inProgress'),
      ),
  );
  return { graph: nextGraph, state: { created, pending, order }, changed };
}

/** Prefer remaining work in the deepest open scope before advancing its siblings. */
export function nextPlannedGoal(
  graph: GoalGraphSnapshot,
  order: readonly GoalRef[],
): GoalRef | null {
  for (const scope of [...graph.goalPath].reverse()) {
    for (const ref of order) {
      let goal = graph.goals.find(
        (item) => item.id === ref.id && item.version === ref.version,
      );
      if (
        !goal ||
        (goal.lifecycle !== 'pending' && goal.lifecycle !== 'inProgress')
      )
        continue;
      while (goal.kind === 'child') {
        if (goal.parentGoalRef.id === scope.id) return ref;
        const parentId: string = goal.parentGoalRef.id;
        goal = graph.goals.find((item) => item.id === parentId)!;
        if (goal.lifecycle !== 'pending' && goal.lifecycle !== 'inProgress')
          break;
      }
    }
  }
  return null;
}
