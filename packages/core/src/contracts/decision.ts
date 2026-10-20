import type { ActionCapability } from './action.js';
import type { CallControl } from './control.js';
import type { GoalAssessment, GoalLifecycle } from './goal.js';
import type { JsonObject, JsonValue } from './json.js';
import type { Observation } from './observation.js';
import type { OperationOffer } from './operation.js';
import type { GoalRef, ObservationRef, PlanRef } from './references.js';
import type { ModelIdentity } from '#internal/model/metadata';
import type { PlanProposalContent } from '#internal/planner/contracts';
import type { ChoiceHistoryEntry } from './choice-history.js';

export type ExecutionDisposition =
  | { readonly kind: 'none' }
  | { readonly kind: 'keep'; readonly executionId: string }
  | { readonly kind: 'stop'; readonly executionId: string };

export interface ProposalDisposition {
  readonly kind: 'defer' | 'discard';
  readonly proposalId: string;
}

/** Complete core-owned meaning of a fixed option; the policy cannot return new bindings. */
export type ControlDecision =
  | ((
      | { readonly kind: 'continueAction'; readonly executionId: string }
      | { readonly kind: 'continueSelection'; readonly selectionId: string }
      | { readonly kind: 'wait' }
      | { readonly kind: 'stopAction'; readonly executionId: string }
      | { readonly kind: 'selectOperation'; readonly operationId: string }
      | {
          readonly kind: 'replan';
          readonly execution: ExecutionDisposition;
        }
      | { readonly kind: 'abstain' }
    ) & { readonly proposal: ProposalDisposition | null })
  | {
      readonly kind: 'adoptPlan';
      readonly proposalId: string;
      readonly execution: ExecutionDisposition;
    };

export interface DecisionOption {
  readonly id: string;
  readonly decision: ControlDecision;
}

/** Request accounting and identity checks belong in records, not model input. */
export interface DecisionBasis {
  readonly runId: string;
  readonly decisionEpoch: number;
  readonly rootGoalRef: GoalRef;
  readonly currentGoalRef: GoalRef;
  readonly goalPath: readonly GoalRef[];
  readonly planRef: PlanRef | null;
  readonly constraintsVersion: number;
  readonly observationRef: ObservationRef;
  readonly reviewVersion: number;
  readonly throughSequence: number;
  readonly operationSetId: string;
  readonly executionId: string | null;
  readonly selectionId: string | null;
  readonly proposalId: string | null;
}

export interface DecisionGoal {
  readonly id: string;
  readonly parentGoalId: string | null;
  readonly description: string;
  readonly criteria: Exclude<JsonValue, null>;
  readonly lifecycle: GoalLifecycle;
  readonly assessment: Pick<
    GoalAssessment,
    'outcome' | 'evidence' | 'reason' | 'progress'
  > | null;
}

/** One option's behavioral meaning; execution and proposal identities stay in the fixed map. */
export interface DecisionChoice {
  readonly id: string;
  readonly kind: ControlDecision['kind'];
  readonly operationId?: string;
  readonly execution?: ExecutionDisposition['kind'];
  readonly proposal?: ProposalDisposition['kind'];
}

export interface DecisionInput {
  readonly recentChoices: readonly ChoiceHistoryEntry[];
  readonly rootGoal: DecisionGoal;
  /** IDs in root-to-current order; goal definitions appear once in rootGoal or acceptedPlan. */
  readonly goalPath: readonly string[];
  readonly acceptedPlan: {
    readonly guidance: string | null;
    readonly goals: readonly DecisionGoal[];
  } | null;
  readonly constraints: JsonObject;
  readonly hardConstraints: readonly JsonValue[];
  readonly preferences: readonly JsonValue[];
  readonly goalLimits: JsonObject;
  /** Historical or application context does not replace observed facts. */
  readonly applicationContext: JsonObject | null;
  readonly snapshot: Pick<
    Observation,
    'source' | 'observedAt' | 'coverage' | 'data'
  >;
  /** All unreviewed facts, in received order, with source-local order retained. */
  readonly changes: readonly {
    readonly source: string;
    readonly sourceEvent: string;
    readonly occurredAt: string | null;
    readonly receivedAt: string;
    readonly data: JsonValue;
    readonly sourceSequence?: number;
    readonly executionId?: string;
  }[];
  readonly execution: {
    readonly actionId: string;
    readonly description: string;
    readonly goalId: string;
    readonly params: JsonObject;
    readonly expectedEffects: JsonObject;
    readonly phase: 'prepared' | 'running';
    readonly progress: JsonObject;
    readonly stopReason: string | null;
  } | null;
  readonly progress: readonly {
    readonly goalId: string;
    readonly noProgress: number;
    readonly recoveryAttempts: number;
    readonly highWater: number | null;
  }[];
  readonly recentEffects: readonly {
    readonly executionId: string;
    readonly outcome: 'succeeded' | 'failed' | 'cancelled' | 'unknown';
    readonly reasonCode: string;
    readonly underlyingSettled: boolean;
    readonly confirmedEffects: JsonObject;
    readonly unresolvedEffects: JsonObject;
    readonly progress: JsonObject;
  }[];
  readonly operations: readonly (Omit<OperationOffer, 'actionVersion'> &
    Pick<
      ActionCapability,
      'description' | 'parameters' | 'expectedEffects' | 'tags'
    >)[];
  readonly informationGaps: readonly string[];
  readonly capabilityGaps: readonly string[];
  readonly selection: {
    readonly operationId: string;
    readonly round: number;
    readonly candidateCount: number;
    readonly completedBatches: number;
    /** Original selection deadline; intervening reviews do not extend it. */
    readonly deadlineAt: string;
  } | null;
  readonly planning: {
    /** Semantic reason, excluding request and event correlation IDs. */
    readonly need: JsonObject | null;
    readonly inFlight: boolean;
    readonly proposal: {
      readonly receivedAt: string;
      readonly content: PlanProposalContent;
    } | null;
  };
  readonly options: readonly DecisionChoice[];
}

export interface DecisionRequest {
  readonly requestId: string;
  readonly basis: DecisionBasis;
  /** The semantic projection for a model request; source data remains in records. */
  readonly input: DecisionInput;
  /** Immutable IDs mapped to complete local bindings; send input.options to a model. */
  readonly options: readonly DecisionOption[];
}

export interface DecisionResult {
  readonly optionId: string;
}

export interface DecisionPolicy {
  /** Declares one model request per callback attempt and enables Agent metering. */
  readonly model?: ModelIdentity;
  /** Return exactly one offered ID. Failures do not acknowledge the request's unread facts. */
  decide(
    request: DecisionRequest,
    control: CallControl,
  ): Promise<DecisionResult>;
}
