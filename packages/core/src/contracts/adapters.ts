import type { ActionResult } from './record.js';
import type { ChangeBatch, ObservationScope } from './changes.js';
import type { GoalAssessment, GoalRecord } from './goal.js';
import type { JsonValue } from './json.js';
import type { Observation } from './observation.js';
import type { CandidateSet } from './candidate.js';
import type { CandidateFilterResult } from './candidate-filter.js';
import type { ActionCapability } from './action.js';
import type { DecisionContext } from './context.js';
import type { CallControl } from './control.js';

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

/** One source supplies current snapshots and, when available, captured changes. */
export interface ObservationSource {
  snapshot(
    context: DecisionContext | null,
    control: CallControl,
  ): Promise<Observation>;
  /**
   * Subscribe once per owned run, before its first snapshot. Publishing captures
   * input immediately and resolves after facts and pending review commit together.
   * Handle rejection; failed publication has not been accepted. Unsubscribe must
   * release source listeners. Pausing a run does not end this subscription.
   */
  changes?(
    scope: ObservationScope,
    publish: (batch: ChangeBatch) => Promise<void>,
  ): () => void;
}

export interface Environment {
  readonly observe: ObservationSource;
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
