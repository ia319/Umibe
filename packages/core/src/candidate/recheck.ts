import { ActionRegistry } from '#internal/action/registry';
import type { ActionCheck } from '#internal/contracts/action';
import type {
  ActionCapability,
  CallControl,
} from '#internal/contracts/adapters';
import type {
  CandidateInvalidationReason,
  CandidateRecheckInput,
  CandidateRecheckResult,
  SelectedCandidate,
} from '#internal/contracts/candidate-processing';
import { ContractError } from '#internal/errors';
import { parseActionCheck } from '#internal/validation/action-check';
import { captureDecisionRequest } from './context.js';
import { captureControl, invokeControlled } from './control.js';
import { candidateContractIssue, invocationFailure } from './diagnostics.js';
import { getSelectedCall } from './handles.js';
import { canonicalJson } from './identity.js';

export function candidateInvalidationReason(
  selected: SelectedCandidate,
  request: CandidateRecheckInput,
  capabilities: readonly ActionCapability[],
): CandidateInvalidationReason | null {
  const original = selected.filtered.checked.prepared.request;
  const previous = original.context;
  const current = request.context;
  const capability = capabilities.find(
    (entry) => entry.id === selected.candidate.actionId,
  );
  if (capability === undefined) return 'action_unavailable';
  if (capability.version !== selected.candidate.actionVersion)
    return 'action_version_changed';
  // A matching version cannot silently substitute another registration's callbacks.
  if (
    capability !==
    original.capabilities.find((entry) => entry.id === capability.id)
  ) {
    return 'action_registration_changed';
  }
  if (current.graph.runId !== previous.graph.runId) return 'run_changed';
  if (request.decisionEpoch !== original.decisionEpoch)
    return 'decision_epoch_changed';
  if (
    current.graph.rootGoalRef.id !== previous.graph.rootGoalRef.id ||
    current.graph.rootGoalRef.version !== previous.graph.rootGoalRef.version
  )
    return 'root_goal_changed';
  if (
    current.graph.currentGoalRef.id !== previous.graph.currentGoalRef.id ||
    current.graph.currentGoalRef.version !==
      previous.graph.currentGoalRef.version
  )
    return 'current_goal_changed';
  if (
    current.graph.goalPath.length !== previous.graph.goalPath.length ||
    current.graph.goalPath.some(
      (ref, index) =>
        ref.id !== previous.graph.goalPath[index]?.id ||
        ref.version !== previous.graph.goalPath[index]?.version,
    )
  ) {
    return 'goal_path_changed';
  }
  const currentGoals = new Map(
    current.graph.goals.map((goal) => [goal.id, goal]),
  );
  const previousGoals = new Map(
    previous.graph.goals.map((goal) => [goal.id, goal]),
  );
  for (const ref of current.graph.goalPath) {
    const goal = currentGoals.get(ref.id)!;
    const prior = previousGoals.get(ref.id)!;
    if (goal.lifecycle !== 'pending' && goal.lifecycle !== 'inProgress')
      return 'inactive_goal_path';
    // Lifecycle progress and assessments may change without replacing the goal definition.
    if (
      goal.kind !== prior.kind ||
      goal.description !== prior.description ||
      canonicalJson(goal.criteria) !== canonicalJson(prior.criteria) ||
      JSON.stringify(goal.parentGoalRef) !==
        JSON.stringify(prior.parentGoalRef) ||
      JSON.stringify(goal.acceptedPlanRef) !==
        JSON.stringify(prior.acceptedPlanRef) ||
      (goal.kind === 'root' &&
        prior.kind === 'root' &&
        canonicalJson([goal.hardConstraints, goal.limits, goal.preferences]) !==
          canonicalJson([
            prior.hardConstraints,
            prior.limits,
            prior.preferences,
          ]))
    ) {
      return 'goal_definition_changed';
    }
  }
  if (
    JSON.stringify(current.planRef) !== JSON.stringify(previous.planRef) ||
    current.planGuidance !== previous.planGuidance
  )
    return 'plan_changed';
  if (
    current.constraintsVersion !== previous.constraintsVersion ||
    canonicalJson(current.effectiveConstraints) !==
      canonicalJson(previous.effectiveConstraints)
  ) {
    return 'constraints_changed';
  }
  if (current.observation.revision < previous.observation.revision)
    return 'observation_regressed';
  if (
    current.observation.revision === previous.observation.revision &&
    canonicalJson({
      ...current.observation,
      coverage: { ...current.observation.coverage },
    }) !==
      canonicalJson({
        ...previous.observation,
        coverage: { ...previous.observation.coverage },
      })
  ) {
    return 'observation_conflict';
  }
  return null;
}

/**
 * Recheck the selected fixed call against a captured authoritative context.
 * Use the original action registration and decision epoch. New observation revisions
 * may change the check result, never the parameters or effective constraints.
 * Invalid arguments reject with ContractError; changed basis, adapter failures and
 * interruptions return distinct outcomes. Recheck success grants no dispatch authority;
 * the runtime must verify live versions again after committing execution intent.
 */
export async function recheckCandidate(
  selected: SelectedCandidate,
  input: CandidateRecheckInput,
  registry: ActionRegistry,
  controlInput: CallControl,
): Promise<CandidateRecheckResult> {
  const call = getSelectedCall(selected);
  const captured = captureDecisionRequest(input);
  if (!(registry instanceof ActionRegistry)) {
    throw new ContractError(
      'INVALID_CANDIDATE_REQUEST',
      'candidate_rechecking',
      '/registry',
      'expected_action_registry',
    );
  }
  const capabilities = registry.capabilities;
  const control = captureControl(controlInput);
  const reason = candidateInvalidationReason(selected, captured, capabilities);
  const stopped = control.signal.aborted
    ? 'cancelled'
    : Date.now() >= control.deadlineMs
      ? 'deadlineExceeded'
      : null;
  if (stopped !== null) {
    return Object.freeze({
      ...invocationFailure(
        { outcome: stopped },
        'rechecking',
        selected.candidate.id,
      ),
      selected,
      request: captured,
    });
  }
  if (reason !== null)
    return Object.freeze({
      outcome: 'invalidated',
      selected,
      request: captured,
      reason,
    });

  const request = Object.freeze({
    ...captured,
    context: Object.freeze({
      ...captured.context,
      effectiveConstraints:
        selected.filtered.checked.prepared.request.context.effectiveConstraints,
    }),
  });
  const result = await invokeControlled<unknown>(control, (control) =>
    call.check(request.context, control),
  );
  if (result.outcome !== 'returned') {
    return Object.freeze({
      ...invocationFailure(result, 'rechecking', selected.candidate.id),
      selected,
      request,
    });
  }
  let check: ActionCheck;
  try {
    check = parseActionCheck(result.value);
  } catch (error) {
    return Object.freeze({
      outcome: 'failed',
      stage: 'rechecking',
      candidateId: selected.candidate.id,
      reason: 'invalid_result',
      issue: candidateContractIssue(error),
      selected,
      request,
    });
  }
  const late = control.signal.aborted
    ? 'cancelled'
    : Date.now() >= control.deadlineMs
      ? 'deadlineExceeded'
      : null;
  if (late !== null) {
    return Object.freeze({
      ...invocationFailure(
        { outcome: late },
        'rechecking',
        selected.candidate.id,
      ),
      selected,
      request,
    });
  }
  return Object.freeze({ outcome: 'rechecked', selected, request, check });
}
