import type { JsonObject, JsonValue } from './json.js';
import type { GoalRef, ObservationRef, PlanRef } from './references.js';

export interface CandidateExclusion {
  readonly stage: 'generation' | 'checking' | 'filtering';
  readonly reason: string;
  readonly count: number;
}

export interface CandidateCoverage {
  readonly generation: 'complete' | 'partial';
  readonly checking: 'complete' | 'partial';
  readonly uncheckedScopes: readonly string[];
  readonly truncated: boolean;
  readonly exclusions: readonly CandidateExclusion[];
  readonly informationGaps: readonly string[];
  readonly capabilityGaps: readonly string[];
}

export interface ParameterSource {
  readonly kind: 'observation' | 'application' | 'model' | 'default';
  /** Fact path, application rule, model request or schema field, as applicable. */
  readonly reference: string;
}

/** A proposed call; its registered action schema must normalize params before checking. */
export interface Candidate {
  readonly id: string;
  readonly candidateSetId: string;
  readonly actionId: string;
  readonly actionVersion: number;
  readonly params: JsonObject;
  /** Every top-level parameter has a declared source; deeper provenance may use a fact path. */
  readonly paramSources: Readonly<Record<string, ParameterSource>>;
  readonly description: string;
  readonly expectedEffects: JsonObject;
  readonly cost: JsonValue | null;
  readonly risk: JsonValue | null;
  readonly source: string;
  readonly goalRef: GoalRef;
  readonly goalPathRef: string;
  readonly planRef: PlanRef;
  readonly observationRef: ObservationRef;
  readonly constraintsVersion: number;
}

/** Shared basis for every candidate; P2 checks the path against the accepted graph. */
export interface CandidateSet {
  readonly id: string;
  readonly runId: string;
  readonly rootGoalRef: GoalRef;
  readonly currentGoalRef: GoalRef;
  readonly goalPathRef: string;
  readonly goalPath: readonly GoalRef[];
  readonly planRef: PlanRef;
  readonly observationRef: ObservationRef;
  readonly constraintsVersion: number;
  readonly coverage: CandidateCoverage;
  readonly candidates: readonly Candidate[];
}
