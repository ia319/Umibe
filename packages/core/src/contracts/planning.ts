import type { JsonValue } from './json.js';
import type { GoalRef, ObservationRef, PlanRef } from './references.js';

export type PlanningTrigger =
  | { readonly kind: 'initial'; readonly assessment: 'notYet' }
  | { readonly kind: 'planInvalidated'; readonly eventId: string }
  | { readonly kind: 'branchExhausted'; readonly goalRef: GoalRef }
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
      }
    | {
        readonly outcome: 'decompose';
        readonly goals: readonly ProposedGoal[];
        readonly nextTempId: string;
        readonly guidance: string;
      }
    | {
        readonly outcome: 'switch';
        readonly nextGoalRef: GoalRef;
        readonly guidance: string;
      }
    | { readonly outcome: 'blocked'; readonly reason: string }
    | { readonly outcome: 'claimComplete'; readonly goalRef: GoalRef }
  );
