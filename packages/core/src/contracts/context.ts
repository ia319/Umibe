import type { ApplicationEvent } from './event.js';
import type { GoalAssessment, GoalGraphSnapshot } from './goal.js';
import type { JsonObject } from './json.js';
import type { Observation } from './observation.js';
import type { ActionResult } from './record.js';
import type { GoalRef, PlanRef } from './references.js';
import type { GoalProgress } from '#internal/runtime/progress';

export interface RuntimeContext {
  readonly execution: {
    readonly executionId: string;
    readonly phase: 'prepared' | 'running' | ActionResult['outcome'];
  } | null;
  readonly recentResults: readonly ActionResult[];
  readonly progress: readonly Pick<
    GoalProgress,
    'goalRef' | 'noProgress' | 'recoveryAttempts' | 'highWater'
  >[];
  readonly blocker: {
    readonly eventId: string;
    readonly reasonCode: string;
  } | null;
  readonly completedSiblings: readonly {
    readonly goalRef: GoalRef;
    readonly assessment: GoalAssessment;
  }[];
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
  /** Bounded runtime history; historical evidence never replaces the current observation. */
  readonly runtime?: RuntimeContext;
}
