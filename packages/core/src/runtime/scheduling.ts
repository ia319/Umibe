import type { DecisionContext } from '#internal/contracts/adapters';
import type { CandidateSet } from '#internal/contracts/candidate';
import type { PlanningTrigger } from '#internal/contracts/planning';
import { canonicalJson } from '#internal/candidate/identity';
import { parseJsonValue } from '#internal/validation/json';

export interface SchedulingState {
  readonly policyVersion: 1;
  readonly planning: PlanningTrigger | null;
  readonly recoveryAttempts: number;
  readonly lastSelectionBasis: string | null;
  readonly selectionCause:
    | 'initial'
    | 'action_completed'
    | 'candidates_changed'
    | 'resumed'
    | 'remedy';
}

/** Sampling metadata and provider IDs never create a new decision reason. */
export function selectionBasis(
  context: DecisionContext,
  candidates: CandidateSet,
): string {
  const path = new Set(context.graph.goalPath.map((ref) => ref.id));
  return canonicalJson(
    parseJsonValue(
      {
        goals: context.graph.goals
          .filter((goal) => path.has(goal.id))
          .map((goal) => ({
            id: goal.id,
            version: goal.version,
            parentGoalRef: goal.parentGoalRef,
            description: goal.description,
            criteria: goal.criteria,
          })),
        guidance: context.planGuidance,
        constraints: context.effectiveConstraints,
        applicationContext: context.applicationContext ?? {},
        facts: context.observation.data,
        candidates: candidates.candidates
          .map((candidate) => ({
            actionId: candidate.actionId,
            actionVersion: candidate.actionVersion,
            params: candidate.params,
            description: candidate.description,
            expectedEffects: candidate.expectedEffects,
            cost: candidate.cost,
            risk: candidate.risk,
          }))
          .map((candidate) => canonicalJson(candidate))
          .sort(),
      },
      'selection_basis',
    ),
  );
}
