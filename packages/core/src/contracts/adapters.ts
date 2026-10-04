import type { ActionResult } from './record.js';
import type { ApplicationEvent } from './event.js';
import type { ChildGoalRecord, GoalAssessment, GoalRecord } from './goal.js';
import type { JsonValue } from './json.js';
import type { Observation } from './observation.js';
import type { CandidateSet } from './candidate.js';
import type { CandidateFilterResult } from './candidate-filter.js';
import type { SelectionResult } from './selection.js';
import type { PlanProposal, PlanningTrigger } from './planning.js';
import type { ActionCapability } from './action.js';
import type { DecisionContext } from './context.js';
import type { CallControl } from './control.js';

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
