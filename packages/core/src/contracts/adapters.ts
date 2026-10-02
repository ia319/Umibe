import type { ActionResult } from './record.js';
import type { ApplicationEvent } from './event.js';
import type {
  ChildGoalRecord,
  GoalAssessment,
  GoalGraphSnapshot,
  GoalRecord,
} from './goal.js';
import type { JsonObject, JsonValue } from './json.js';
import type { Observation } from './observation.js';
import type { PlanRef } from './references.js';
import type { CandidateSet } from './candidate.js';
import type { CandidateFilterResult } from './candidate-filter.js';
import type { SelectionResult } from './selection.js';
import type { PlanProposal, PlanningTrigger } from './planning.js';

/** One invocation owns its cancellation signal; a cancelled call cannot authorize a later effect. */
export interface CallControl {
  readonly signal: AbortSignal;
  /** Absolute UTC deadline, including the time spent waiting for an adapter. */
  readonly deadlineAt: string;
}

export interface DecisionContext {
  readonly graph: GoalGraphSnapshot;
  readonly planRef: PlanRef | null;
  /** Current accepted guidance; goal relations remain in the graph. */
  readonly planGuidance: string | null;
  readonly observation: Observation;
  readonly constraintsVersion: number;
  readonly effectiveConstraints: JsonObject;
  readonly lastActionResult: ActionResult | null;
  readonly recentEvents: readonly ApplicationEvent[];
  /** Application-supplied task context; separate from observed facts and hard constraints. */
  readonly applicationContext?: JsonObject;
}

export interface ActionCapability {
  readonly id: string;
  readonly version: number;
  readonly description: string;
  readonly parameters: JsonObject;
  readonly expectedEffects: JsonObject;
  readonly tags: readonly string[];
}

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
  plan(request: PlannerRequest, control: CallControl): Promise<PlanProposal>;
}

export interface CandidateRequest {
  readonly requestId: string;
  readonly decisionEpoch: number;
  readonly context: DecisionContext;
  readonly capabilities: readonly ActionCapability[];
}

/** Returns complete action calls and explicit coverage, including when no calls were found. */
export interface CandidateProvider {
  generate(
    request: CandidateRequest,
    control: CallControl,
  ): Promise<CandidateSet>;
}

export interface SelectorRequest {
  readonly requestId: string;
  readonly decisionEpoch: number;
  readonly context: DecisionContext;
  readonly candidates: CandidateSet;
}

export interface CandidateFilterRequest extends CandidateRequest {
  readonly candidates: CandidateSet;
}

/** Return IDs and reasons for every input member; the core retains all call data. */
export interface CandidateFilter {
  filter(
    request: CandidateFilterRequest,
    control: CallControl,
  ): Promise<CandidateFilterResult>;
}

export interface Selector {
  select(
    request: SelectorRequest,
    control: CallControl,
  ): Promise<SelectionResult>;
}

/** The application owns observation semantics and may additionally publish domain events. */
export interface Environment {
  observe(
    context: DecisionContext | null,
    control: CallControl,
  ): Promise<Observation>;
  subscribe?(emit: (event: ApplicationEvent) => void): () => void;
}

export type CriteriaSupport<TCriteria extends JsonValue> =
  | {
      readonly outcome: 'supported';
      readonly criteria: TCriteria;
      readonly requiredEvidence: readonly string[];
    }
  | { readonly outcome: 'unsupported' | 'needsInput'; readonly reason: string };

export interface VerificationRequest<TCriteria extends JsonValue> {
  readonly goal: GoalRecord;
  readonly criteria: TCriteria;
  readonly context: DecisionContext;
  readonly actionResults: readonly ActionResult[];
}

/** Decode proposed criteria before admission; verify only against fresh, traceable evidence. */
export interface Verifier<TCriteria extends JsonValue = JsonValue> {
  support(
    criteria: JsonValue,
    control: CallControl,
  ): Promise<CriteriaSupport<TCriteria>>;
  verify(
    request: VerificationRequest<TCriteria>,
    control: CallControl,
  ): Promise<GoalAssessment>;
}
