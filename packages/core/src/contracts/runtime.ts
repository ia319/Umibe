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
  Verifier,
} from './adapters.js';
import type { Selector } from '#internal/selector/contracts';
import type { Planner } from '#internal/planner/contracts';
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
  /** Stable application identity; required by durable stores. Never use credentials here. */
  readonly applicationId?: string;
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
  /**
   * Mark custom callbacks backed by model requests. Planner and Selector model
   * identities always enable their stages, including when this array is empty.
   */
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
  /**
   * Acquire a stored run when necessary and continue from its committed checkpoint.
   * Requires matching application, action versions and model stages. Preserves
   * stored limits and usage; uncertain executions must reconcile before dispatch.
   * After notPerformed, the next call must match the saved action ID, version and
   * normalized parameters, and remains subject to the saved retry policy and count.
   * A changed call pauses with retry_call_changed; a forbidden or exhausted retry
   * pauses with retry_not_allowed. The handle's result reports these blockers.
   * Repeated resume calls preserve the saved call and retry count.
   */
  resume(runId: string, update?: ResumeRun): Promise<RunHandle>;
  /**
   * Reconcile unresolved effects without resuming, including after cancellation.
   * A notPerformed result preserves the call and retry limits for {@link Agent.resume}.
   */
  reconcile(runId: string): Promise<Reconciliation>;
  pause(runId: string, reasonCode: string): Promise<void>;
  cancel(runId: string, reasonCode: string): Promise<void>;
  /**
   * Check persisted IDs before admitting a domain event. Identical duplicates
   * have no effect; conflicting content rejects. Commit accepted controls with
   * the event and its scheduling changes in the same transaction.
   */
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
   * Rejects before closing any run if initialization or work remains active.
   */
  close(): Promise<void>;
}
