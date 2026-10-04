import type {
  ChildGoalRecord,
  GoalGraphSnapshot,
} from '#internal/contracts/goal';
import type { GoalRevision } from '#internal/planner/contracts';
import type { GoalRef, PlanRef } from '#internal/contracts/references';
import { ContractError } from '#internal/errors';
import { parseGoalGraph } from '#internal/validation/goal';
import { canonicalJson } from '#internal/candidate/identity';

/** Replace accepted versions together; descendants not in the batch lose dispatch eligibility. */
export function reviseGoalGraph(
  graph: GoalGraphSnapshot,
  pending: readonly ChildGoalRecord[],
  revisions: readonly GoalRevision[],
  next: GoalRef,
  planRef: PlanRef,
  mode: 'revise' | 'reconfirm',
): {
  graph: GoalGraphSnapshot;
  pending: readonly ChildGoalRecord[];
  changed: readonly ChildGoalRecord[];
} {
  const invalid: (reason: string) => never = (reason) => {
    throw new ContractError(
      'INVALID_PLAN_PROPOSAL',
      'goal_revision',
      '/revisions',
      reason,
    );
  };
  const known = new Map(
    [...pending, ...graph.goals].map((goal) => [goal.id, goal]),
  );
  const changed = new Map<string, ChildGoalRecord>();
  if (revisions.length === 0) invalid('empty_revisions');
  for (const revision of revisions) {
    const previous = known.get(revision.goalRef.id);
    if (
      !previous ||
      previous.kind === 'root' ||
      previous.version !== revision.goalRef.version
    )
      invalid('missing_or_stale_child');
    if (
      previous.lifecycle === 'succeeded' ||
      previous.lifecycle === 'cancelled'
    )
      invalid('inactive_goal');
    if (changed.has(previous.id)) invalid('duplicate_revision');
    if (
      mode === 'reconfirm' &&
      (previous.description !== revision.description ||
        canonicalJson(previous.criteria) !== canonicalJson(revision.criteria))
    )
      invalid('reconfirmation_changed_definition');
    const parent = known.get(revision.parentGoalRef.id);
    if (!parent || parent.version !== revision.parentGoalRef.version)
      invalid('missing_or_stale_parent');
    changed.set(previous.id, {
      ...previous,
      version: previous.version + 1,
      parentGoalRef: revision.parentGoalRef,
      acceptedPlanRef: planRef,
      description: revision.description,
      criteria: revision.criteria,
      lifecycle: 'pending',
      lastAssessment: null,
    });
  }
  const removed = new Set(changed.keys());
  // Propagate through all descendants, including completed history with old parent versions.
  for (let size = -1; size !== removed.size;) {
    size = removed.size;
    for (const goal of graph.goals)
      if (goal.kind === 'child' && removed.has(goal.parentGoalRef.id))
        removed.add(goal.id);
  }
  const retained = graph.goals.filter((goal) => !removed.has(goal.id));
  for (const [id, goal] of changed) {
    const parent =
      changed.get(goal.parentGoalRef.id) ??
      retained.find((item) => item.id === goal.parentGoalRef.id);
    if (
      !parent ||
      (parent.lifecycle !== 'pending' && parent.lifecycle !== 'inProgress')
    )
      invalid('inactive_or_unconfirmed_parent');
    changed.set(id, {
      ...goal,
      parentGoalRef: { id: parent.id, version: parent.version },
    });
  }
  const target =
    changed.get(next.id) ?? retained.find((goal) => goal.id === next.id);
  if (!target || known.get(next.id)?.version !== next.version)
    invalid('missing_next_goal');
  const accepted = parseGoalGraph({
    runId: graph.runId,
    rootGoalRef: graph.rootGoalRef,
    currentGoalRef: { id: target.id, version: target.version },
    goals: [...retained, ...changed.values()],
  });
  const deferred = new Map(pending.map((goal) => [goal.id, goal]));
  for (const goal of graph.goals)
    if (goal.kind === 'child' && removed.has(goal.id) && !changed.has(goal.id))
      deferred.set(goal.id, {
        ...goal,
        lifecycle: 'superseded',
        lastAssessment: null,
      });
  for (const id of changed.keys()) deferred.delete(id);
  return {
    graph: accepted,
    pending: Object.freeze([...deferred.values()]),
    changed: Object.freeze([...changed.values()]),
  };
}
