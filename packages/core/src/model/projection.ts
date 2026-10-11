import type { DecisionContext } from '#internal/contracts/context';
import type { GoalAssessment, GoalRecord } from '#internal/contracts/goal';
import type { Observation } from '#internal/contracts/observation';
import type { ActionResult } from '#internal/contracts/record';
import type { PlannerRequest } from '#internal/planner/contracts';
import type { SelectorRequest } from '#internal/selector/contracts';
import { canonicalJson } from '#internal/candidate/identity';
import { parseJsonValue } from '#internal/validation/json';

function projectAssessment(
  assessment: GoalAssessment | null,
  snapshot: Observation,
) {
  return assessment === null
    ? null
    : {
        outcome: assessment.outcome,
        basedOnCurrentSnapshot:
          assessment.observationRef.id === snapshot.id &&
          assessment.observationRef.revision === snapshot.revision,
        evidence: assessment.evidence,
        reason: assessment.reason,
        ...(assessment.progress === undefined
          ? {}
          : { progress: assessment.progress }),
      };
}

function projectGoal(goal: GoalRecord, snapshot: Observation) {
  return {
    id: goal.id,
    version: goal.version,
    parentGoalRef: goal.parentGoalRef,
    description: goal.description,
    criteria: goal.criteria,
    lifecycle: goal.lifecycle,
    assessment: projectAssessment(goal.lastAssessment, snapshot),
    ...(goal.kind === 'root'
      ? {
          hardConstraints: goal.hardConstraints,
          preferences: goal.preferences,
          limits: goal.limits,
        }
      : {}),
  };
}

function projectResult(result: ActionResult) {
  return {
    executionId: result.executionId,
    outcome: result.outcome,
    reasonCode: result.reasonCode,
    underlyingSettled: result.underlyingSettled,
    confirmedEffects: result.confirmedEffects,
    unresolvedEffects: result.unresolvedEffects,
    progress: result.progress,
  };
}

/** Keep goal definitions once and retain only references needed for output or evidence joins. */
function projectContext(context: DecisionContext) {
  const snapshot = context.observation;
  const execution = context.runtime?.execution;
  const root = context.graph.goals.find(
    (goal) => goal.id === context.graph.rootGoalRef.id,
  )!;
  const recentResults = context.runtime?.recentResults ?? [];
  const lastResult = context.lastActionResult;
  const lastResultKey =
    lastResult === null
      ? null
      : canonicalJson(parseJsonValue(lastResult, 'model_projection'));
  return {
    rootGoal: projectGoal(root, snapshot),
    goals: context.graph.goals
      .filter((goal) => goal.id !== root.id)
      .map((goal) => projectGoal(goal, snapshot)),
    goalPath: context.graph.goalPath,
    acceptedPlan:
      context.planRef === null ? null : { guidance: context.planGuidance },
    constraints: context.effectiveConstraints,
    applicationContext: context.applicationContext ?? null,
    snapshot: {
      source: snapshot.source,
      observedAt: snapshot.observedAt,
      coverage: snapshot.coverage,
      data: snapshot.data,
    },
    recentEvents: context.recentEvents.map((event) => ({
      type: event.type,
      source: event.source,
      observedAt: event.observedAt,
      reasonCode: event.reasonCode,
      currentGoalRef: event.currentGoalRef,
      executionId: event.executionId,
      affectedGoalRefs: event.affectedGoalRefs,
      details: event.details,
    })),
    execution:
      execution === undefined || execution === null
        ? null
        : {
            executionId: execution.executionId,
            actionId: execution.intent.actionId,
            actionVersion: execution.intent.actionVersion,
            goalRef: execution.intent.currentGoalRef,
            params: execution.intent.params,
            phase: execution.phase,
            progress: execution.progress,
            stopReason: execution.stopCause?.reasonCode ?? null,
          },
    recentResults: [
      ...recentResults,
      ...(lastResult !== null &&
      !recentResults.some(
        (result) =>
          canonicalJson(parseJsonValue(result, 'model_projection')) ===
          lastResultKey,
      )
        ? [lastResult]
        : []),
    ].map(projectResult),
    progress: context.runtime?.progress ?? [],
    blocker: context.runtime?.blocker?.reasonCode ?? null,
    completedSiblings: (context.runtime?.completedSiblings ?? []).map(
      (sibling) => ({
        goalRef: sibling.goalRef,
        assessment: projectAssessment(sibling.assessment, snapshot),
      }),
    ),
  };
}

/** Project planning facts while preserving goal references required by proposal output. */
export function projectPlannerInput(
  request: PlannerRequest,
  criteriaDescription: string | null,
) {
  const trigger = request.trigger;
  return {
    context: projectContext(request.context),
    capabilities: request.capabilities,
    trigger:
      trigger.kind === 'decision'
        ? { kind: trigger.kind, goalRef: trigger.goalRef }
        : trigger.kind === 'planInvalidated'
          ? { kind: trigger.kind }
          : trigger,
    pendingGoals: (request.pendingGoals ?? []).map((goal) =>
      projectGoal(goal, request.context.observation),
    ),
    criteriaDescription,
  };
}

/** Share the same facts between structured selection and native fixed-option comparison. */
export function projectSelectionInput(request: SelectorRequest) {
  return {
    context: projectContext(request.context),
    coverage: request.candidates.coverage,
    candidates: request.candidates.candidates.map((candidate) => ({
      id: candidate.id,
      actionId: candidate.actionId,
      actionVersion: candidate.actionVersion,
      params: candidate.params,
      paramSources: candidate.paramSources,
      description: candidate.description,
      expectedEffects: candidate.expectedEffects,
      cost: candidate.cost,
      risk: candidate.risk,
      source: candidate.source,
      goalRef: candidate.goalRef,
    })),
  };
}
