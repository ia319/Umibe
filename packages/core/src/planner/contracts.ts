import type { JsonValue } from '#internal/contracts/json';
import type {
  GoalRef,
  ObservationRef,
  PlanRef,
} from '#internal/contracts/references';
import type { ActionCapability } from '#internal/contracts/action';
import type { CallControl } from '#internal/contracts/control';
import type { DecisionContext } from '#internal/contracts/context';
import type { ChildGoalRecord } from '#internal/contracts/goal';
import type { ModelIdentity } from '#internal/model/metadata';

export interface PlannerRequest {
  readonly requestId: string;
  readonly decisionEpoch: number;
  readonly context: DecisionContext;
  readonly capabilities: readonly ActionCapability[];
  readonly trigger: PlanningTrigger;
  /** Invalidated descendants retained for explicit revision or reconfirmation. */
  readonly pendingGoals?: readonly ChildGoalRecord[];
}

/** The core validates and accepts a proposal; the planner never mutates accepted goals. */
export interface Planner {
  /** Declares one model request per attempt and enables automatic Agent metering. */
  readonly model?: ModelIdentity;
  plan(request: PlannerRequest, control: CallControl): Promise<PlanProposal>;
}

export type PlanningTrigger =
  | { readonly kind: 'initial'; readonly assessment: 'notYet' }
  | { readonly kind: 'planInvalidated'; readonly eventId: string }
  | { readonly kind: 'branchExhausted'; readonly goalRef: GoalRef }
  | {
      readonly kind: 'selectionUnavailable';
      readonly goalRef: GoalRef;
      readonly reason: 'abstain' | 'no_candidates';
      /** Number of selection recovery requests, not an exhausted attempt limit. */
      readonly attempts: number;
    }
  | {
      readonly kind: 'recoveryExhausted';
      readonly goalRef: GoalRef;
      readonly failures: number;
    };

export type ProposedParent =
  | { readonly kind: 'accepted'; readonly goalRef: GoalRef }
  | { readonly kind: 'proposed'; readonly tempId: string };

export interface ProposedGoal {
  /** Local to this proposal; the core assigns accepted IDs and versions. */
  readonly tempId: string;
  readonly parent: ProposedParent;
  readonly description: string;
  readonly criteria: Exclude<JsonValue, null>;
}

export interface GoalRevision {
  readonly goalRef: GoalRef;
  /** Bind to an accepted parent, or the old reference of a parent in this revision batch. */
  readonly parentGoalRef: GoalRef;
  readonly description: string;
  readonly criteria: Exclude<JsonValue, null>;
}

interface ProposalBasis {
  readonly requestId: string;
  readonly decisionEpoch: number;
  readonly rootGoalRef: GoalRef;
  readonly currentGoalRef: GoalRef;
  readonly planRef: PlanRef | null;
  readonly observationRef: ObservationRef;
}

export type PlanProposal = ProposalBasis &
  (
    | {
        readonly outcome: 'continue';
        readonly nextGoalRef: GoalRef;
        readonly guidance: string;
        readonly goalOrder?: readonly GoalRef[];
      }
    | {
        readonly outcome: 'decompose';
        readonly goals: readonly ProposedGoal[];
        readonly nextTempId: string;
        readonly guidance: string;
        /** Temporary IDs in advancement order; omission uses proposal order. */
        readonly goalOrder?: readonly string[];
      }
    | {
        readonly outcome: 'switch';
        readonly nextGoalRef: GoalRef;
        readonly guidance: string;
        readonly goalOrder?: readonly GoalRef[];
      }
    | {
        readonly outcome: 'revise' | 'reconfirm';
        readonly revisions: readonly GoalRevision[];
        /** Reference before revision; the core selects the newly accepted version. */
        readonly nextGoalRef: GoalRef;
        readonly guidance: string;
        readonly goalOrder?: readonly GoalRef[];
      }
    | { readonly outcome: 'blocked'; readonly reason: string }
    | { readonly outcome: 'claimComplete'; readonly goalRef: GoalRef }
  );
