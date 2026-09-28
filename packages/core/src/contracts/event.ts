import type { JsonObject } from './json.js';
import type { GoalRef, ObservationRef, PlanRef } from './references.js';

/** Application events report facts and requested control, never action completion. */
export interface ApplicationEvent {
  readonly kind: 'application';
  readonly eventId: string;
  readonly runId: string;
  readonly type: string;
  readonly source: {
    readonly kind: 'application';
    readonly id: string;
  };
  /** Canonical UTC timestamp with millisecond precision. */
  readonly observedAt: string;
  readonly reasonCode: string;
  readonly impact: 'observation' | 'candidates' | 'plan';
  readonly timing: 'immediate' | 'actionBoundary';
  readonly control: 'none' | 'interruptAction' | 'pauseRun' | 'cancelRun';
  readonly currentGoalRef: GoalRef | null;
  readonly planRef: PlanRef | null;
  readonly goalPathRef: string | null;
  readonly executionId: string | null;
  readonly observationRef: ObservationRef | null;
  readonly affectedGoalRefs: readonly GoalRef[];
  readonly details: JsonObject;
}
