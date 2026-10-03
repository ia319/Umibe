import type { RegisteredAction } from '#internal/action/registry';
import type { RuntimeLimits } from '#internal/runtime/limits';
import type { RuntimeDiagnostic } from '#internal/runtime/session';
import type { RunControlState } from '#internal/runtime/state';
import type { ExecutionSnapshot } from '#internal/runtime/execution';
import type {
  RunStore,
  RecordCursor,
  RecordPage,
} from '#internal/storage/contracts';
import type {
  CandidateFilter,
  CandidateProvider,
  Environment,
  Planner,
  Selector,
  Verifier,
} from './adapters.js';
import type { RootGoalRecord } from './goal.js';
import type { JsonObject, JsonValue } from './json.js';
import type { RunCheckpoint, RunRecord, RunSummary } from './record.js';
import type { ApplicationEvent } from './event.js';
import type { Reconciliation } from './action.js';

export type ModelStage =
  'planning' | 'selection' | 'candidates' | 'verification';

export type GoalDefinition = Omit<
  RootGoalRecord,
  | 'kind'
  | 'runId'
  | 'parentGoalRef'
  | 'acceptedPlanRef'
  | 'lifecycle'
  | 'lastAssessment'
>;

export interface StartRun {
  /** Supply the same ID in observations returned during initialization. */
  readonly runId: string;
  readonly goal: GoalDefinition;
  readonly effectiveConstraints: JsonObject;
  readonly context?: JsonObject;
}

export interface ResumeRun {
  /** Merge application context keys without treating them as observations. */
  readonly context?: JsonObject;
  readonly effectiveConstraints?: JsonObject;
  /** Keep the root ID and increment its version by one; supply effectiveConstraints with a changed root. */
  readonly goal?: GoalDefinition;
  /** Increase limits only. Existing usage, progress and recovery counters remain cumulative. */
  readonly limits?: Partial<
    Pick<
      RuntimeLimits,
      | 'maxActionAttempts'
      | 'maxModelAttempts'
      | 'maxGoalDepth'
      | 'maxSubgoals'
      | 'maxNoProgress'
      | 'maxRecoveryAttempts'
    >
  >;
}

export interface AgentOptions<TCriteria extends JsonValue = JsonValue> {
  readonly actions: readonly RegisteredAction[];
  readonly planner: Planner;
  readonly selector: Selector;
  readonly candidateProvider: CandidateProvider;
  readonly environment: Environment;
  readonly verifier: Verifier<TCriteria>;
  /** The caller retains ownership; closing the agent never closes this store. */
  readonly store: RunStore;
  readonly candidateFilter?: CandidateFilter;
  readonly selectorCapacity?: number;
  readonly limits?: Partial<RuntimeLimits>;
  /** Mark callbacks backed by model requests; omitted stages run locally without model charges. */
  readonly modelStages?: readonly ModelStage[];
  readonly onDiagnostic?: (diagnostic: RuntimeDiagnostic) => void;
}

export interface RunResult extends RunControlState {
  readonly runId: string;
  /** May remain unknown after cancellation; cancellation never proves effects were rolled back. */
  readonly execution: ExecutionSnapshot | null;
}

export interface RunHandle {
  readonly runId: string;
  /** Settles after the paused or final checkpoint commits; storage failure rejects. */
  readonly result: Promise<RunResult>;
}

export interface RunInspection {
  readonly summary: RunSummary;
  readonly checkpoint: RunCheckpoint;
}

export interface Agent {
  /** Wait for initialization, then return without waiting for goal completion. Invalid initialization rejects. */
  start(input: StartRun): Promise<RunHandle>;
  /** Continue a paused run owned by this instance, preserving cumulative budgets and issuing a new result promise. */
  resume(runId: string, update?: ResumeRun): Promise<RunHandle>;
  /** Reconcile unresolved effects without resuming, including after cancellation. */
  reconcile(runId: string): Promise<Reconciliation>;
  pause(runId: string, reasonCode: string): Promise<void>;
  cancel(runId: string, reasonCode: string): Promise<void>;
  /** Commit a domain event; duplicate IDs are idempotent only for identical content. */
  emit(event: ApplicationEvent): Promise<void>;
  /** Read the committed checkpoint without changing execution or acquiring a run. */
  inspect(runId: string): Promise<RunInspection | null>;
  records(
    runId: string,
    cursor: RecordCursor | null,
    limit: number,
  ): Promise<RecordPage>;
  subscribe(runId: string, listener: (record: RunRecord) => void): () => void;
  /**
   * Release all owned runs after their writes and executions settle.
   * Throws before closing any run if initialization or work remains active.
   */
  close(): void;
}
