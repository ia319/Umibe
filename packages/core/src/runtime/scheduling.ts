import type { PlanningTrigger } from '#internal/planner/contracts';
import { ContractError } from '#internal/errors';

export interface SchedulingConfiguration {
  readonly reviewIntervalMs: number | null;
  readonly minDecisionIntervalMs: number;
}

export interface SchedulingState extends SchedulingConfiguration {
  readonly policyVersion: 2;
  readonly reviewPending: boolean;
  /** Increases for each admitted trigger, so accepting one review cannot lose a later trigger. */
  readonly reviewVersion: number;
  readonly lastDecisionStartedAt: string | null;
  readonly planning: PlanningTrigger | null;
  /** Each new planning demand receives a version, including repeated identical reasons. */
  readonly planningVersion: number;
}

export function captureScheduling(input: {
  readonly reviewIntervalMs?: number;
  readonly minDecisionIntervalMs?: number;
}): SchedulingConfiguration {
  for (const [key, value] of Object.entries(input)) {
    if (key !== 'reviewIntervalMs' && key !== 'minDecisionIntervalMs')
      throw new ContractError(
        'INVALID_RUN_CONTROL',
        'scheduling',
        `/${key}`,
        'unknown_scheduling_option',
      );
    if (
      value !== undefined &&
      (typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < (key === 'reviewIntervalMs' ? 1 : 0) ||
        value > 2_147_483_647)
    )
      throw new ContractError(
        'INVALID_RUN_CONTROL',
        'scheduling',
        `/${key}`,
        'invalid_scheduling_interval',
      );
  }
  return Object.freeze({
    reviewIntervalMs: input.reviewIntervalMs ?? null,
    minDecisionIntervalMs: input.minDecisionIntervalMs ?? 0,
  });
}

/** Admit a new trigger without clearing facts or an earlier pending review. */
export function requestReview(state: SchedulingState): SchedulingState {
  const reviewVersion = state.reviewVersion + 1;
  if (!Number.isSafeInteger(reviewVersion))
    throw new ContractError(
      'INVALID_RUN_CONTROL',
      'scheduling',
      '/reviewVersion',
      'sequence_exhausted',
    );
  return Object.freeze({ ...state, reviewPending: true, reviewVersion });
}

/** Version every demand so a returning proposal cannot consume a newer planning need. */
export function requestPlanning(
  state: SchedulingState,
  planning: PlanningTrigger,
): SchedulingState {
  const planningVersion = state.planningVersion + 1;
  if (!Number.isSafeInteger(planningVersion))
    throw new ContractError(
      'INVALID_RUN_CONTROL',
      'scheduling',
      '/planningVersion',
      'sequence_exhausted',
    );
  return Object.freeze({ ...state, planning, planningVersion });
}
