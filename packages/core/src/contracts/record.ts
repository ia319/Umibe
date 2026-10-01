import type { ApplicationEvent } from './event.js';
import type { GoalAssessment } from './goal.js';
import type { JsonObject } from './json.js';
import type { GoalRef, ObservationRef, PlanRef } from './references.js';

export type RunStatus =
  | 'created'
  | 'running'
  | 'pausing'
  | 'paused'
  | 'cancelling'
  | 'cancelled'
  | 'succeeded'
  | 'failed';

export interface CoreEventData {
  readonly source: 'core';
  readonly type: string;
  readonly reasonCode: string;
  readonly goalRef: GoalRef | null;
  readonly decisionId: string | null;
  readonly requestId: string | null;
  readonly executionId: string | null;
  readonly details: JsonObject;
}

/** The recorded, normalized call that may be dispatched after atomic intent commit. */
export interface ActionIntent {
  readonly executionId: string;
  readonly decisionId: string;
  readonly candidateSetId: string;
  readonly candidateId: string;
  readonly actionId: string;
  readonly actionVersion: number;
  readonly params: JsonObject;
  readonly rootGoalRef: GoalRef;
  readonly currentGoalRef: GoalRef;
  readonly goalPathRef: string;
  readonly planRef: PlanRef;
  readonly observationRef: ObservationRef;
  readonly constraintsVersion: number;
}

export interface ActionResult {
  readonly executionId: string;
  readonly outcome: 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  readonly reasonCode: string;
  readonly underlyingSettled: boolean;
  readonly confirmedEffects: JsonObject;
  readonly unresolvedEffects: JsonObject;
  readonly progress: JsonObject;
  readonly stopCauseEventId: string | null;
}

interface RunRecordBase {
  readonly formatVersion: 1;
  readonly eventId: string;
  readonly runId: string;
  /** Store-assigned, increasing within one run; wall-clock time is not ordering. */
  readonly sequence: number;
  readonly committedAt: string;
}

export type RunRecord = RunRecordBase &
  (
    | { readonly kind: 'applicationEvent'; readonly data: ApplicationEvent }
    | { readonly kind: 'coreEvent'; readonly data: CoreEventData }
    | { readonly kind: 'actionIntent'; readonly data: ActionIntent }
    | { readonly kind: 'actionResult'; readonly data: ActionResult }
    | { readonly kind: 'goalAssessment'; readonly data: GoalAssessment }
  );

export interface RunSummary {
  readonly formatVersion: 1;
  readonly runId: string;
  readonly status: RunStatus;
  readonly rootGoalRef: GoalRef;
  readonly currentGoalRef: GoalRef | null;
  readonly lastSequence: number;
  readonly lastActivityAt: string;
  readonly checkpointRevision: number;
}

/** The continuation schema is owned by the later runtime and versioned separately. */
export interface RunCheckpoint {
  readonly formatVersion: 1;
  readonly runId: string;
  readonly revision: number;
  readonly committedSequence: number;
  readonly status: RunStatus;
  readonly stateSchemaVersion: number;
  readonly state: JsonObject;
}
