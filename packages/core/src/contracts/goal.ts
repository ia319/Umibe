import type { JsonObject, JsonValue } from './json.js';
import type { GoalRef, ObservationRef, PlanRef } from './references.js';

export type GoalLifecycle =
  'pending' | 'inProgress' | 'succeeded' | 'cancelled' | 'superseded';

interface AssessmentBase {
  readonly goalRef: GoalRef;
  readonly observationRef: ObservationRef;
}

export interface GoalEvidence {
  readonly source: 'application' | 'model' | 'human';
  /** Keys in the bound observation; the verifier must identify the facts it used. */
  readonly observationPaths: readonly string[];
  readonly executionIds: readonly string[];
  readonly details: JsonObject;
}

export type GoalAssessment = AssessmentBase &
  (
    | {
        readonly outcome: 'passed';
        readonly evidence: GoalEvidence;
        readonly reason: null;
      }
    | {
        readonly outcome: 'notYet' | 'needsInput';
        readonly evidence: GoalEvidence | null;
        readonly reason: string;
      }
  );

interface GoalBase extends GoalRef {
  readonly runId: string;
  readonly description: string;
  /** The configured verifier interprets this application-owned condition. */
  readonly criteria: Exclude<JsonValue, null>;
  readonly lifecycle: GoalLifecycle;
  readonly lastAssessment: GoalAssessment | null;
}

export interface RootGoalRecord extends GoalBase {
  readonly kind: 'root';
  readonly parentGoalRef: null;
  readonly acceptedPlanRef: null;
  readonly hardConstraints: readonly JsonValue[];
  readonly limits: JsonObject;
  readonly preferences: readonly JsonValue[];
}

export interface ChildGoalRecord extends GoalBase {
  readonly kind: 'child';
  readonly parentGoalRef: GoalRef;
  readonly acceptedPlanRef: PlanRef;
}

export type GoalRecord = RootGoalRecord | ChildGoalRecord;

/** Contains only the currently accepted version of each goal ID. */
export interface GoalGraph {
  readonly runId: string;
  readonly rootGoalRef: GoalRef;
  readonly currentGoalRef: GoalRef;
  readonly goals: readonly GoalRecord[];
}

/** The path is derived from accepted parent references, never accepted as input. */
export interface GoalGraphSnapshot extends GoalGraph {
  readonly goalPath: readonly GoalRef[];
}
