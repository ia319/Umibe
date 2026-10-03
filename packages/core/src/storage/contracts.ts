import type { JsonObject } from '../contracts/json.js';
import type { GoalRef } from '../contracts/references.js';
import type {
  RunCheckpoint,
  RunRecord,
  RunStatus,
  RunSummary,
} from '../contracts/record.js';

type RecordWithoutStoreFields<T> = T extends RunRecord
  ? Omit<T, 'sequence' | 'committedAt'>
  : never;

/** The writer supplies stable event IDs; the store assigns commit order and time. */
export type RunRecordDraft = RecordWithoutStoreFields<RunRecord>;

export interface RunCommit {
  readonly ownerToken: string;
  readonly runId: string;
  /** Null creates a run; a number compares the last committed checkpoint revision. */
  readonly expectedRevision: number | null;
  readonly status: RunStatus;
  readonly rootGoalRef: GoalRef;
  readonly currentGoalRef: GoalRef | null;
  readonly stateSchemaVersion: number;
  readonly state: JsonObject;
  readonly records: readonly RunRecordDraft[];
}

export type CommitResult =
  | {
      readonly outcome: 'committed';
      readonly summary: RunSummary;
      readonly checkpoint: RunCheckpoint;
      readonly records: readonly RunRecord[];
    }
  | {
      readonly outcome: 'conflict';
      readonly actualRevision: number | null;
    };

/** A cursor is valid only for the run that produced it. */
export interface RecordCursor {
  readonly runId: string;
  readonly sequence: number;
}

export interface RecordPage {
  readonly records: readonly RunRecord[];
  /** Null means the page reached the committed end of this run. */
  readonly nextCursor: RecordCursor | null;
}

/** Async, per-run persistence with atomic compare-and-commit semantics. */
export interface RunStore {
  readonly info: {
    readonly kind: string;
    readonly durable: boolean;
    readonly path: string | null;
  };
  /** Aborted on closure or fatal failure, including while no request is pending. */
  readonly signal: AbortSignal;
  /** Claim an existing or new run; a second holder rejects until release. */
  acquireRun(runId: string): Promise<RunLease>;
  /** Read one committed record without acquiring execution rights. */
  readRecord(runId: string, eventId: string): Promise<RunRecord | null>;
  /**
   * Read the latest committed state of a run.
   * @param runId - The run to read.
   * @returns A frozen snapshot, or null when the run does not exist.
   * @throws StoreClosedError if the store is closed; ContractError for invalid input.
   */
  readRun(runId: string): Promise<{
    readonly summary: RunSummary;
    readonly checkpoint: RunCheckpoint;
  } | null>;
  /**
   * Read committed records in sequence order.
   * @param runId - The run to read.
   * @param cursor - A cursor for this run, or null to start at its first record.
   * @param limit - A positive maximum number of records.
   * @returns A frozen page; a null next cursor marks the current committed end.
   * @throws StoreClosedError if closed; ContractError for invalid or mismatched cursors.
   */
  readRecords(
    runId: string,
    cursor: RecordCursor | null,
    limit: number,
  ): Promise<RecordPage>;
  /**
   * Capture input before returning, then atomically compare and commit the batch.
   * @param input - A complete batch with the expected checkpoint revision.
   * @returns The committed snapshot, or a conflict without changes.
   * @throws StoreClosedError if closed; ContractError for invalid data, before conflict handling.
   */
  commit(input: RunCommit): Promise<CommitResult>;
  /**
   * Finish earlier operations and release owned resources. Repeated calls are safe.
   * @returns A promise that settles when the store has closed.
   */
  close(): Promise<void>;
}

export interface RunLease {
  readonly runId: string;
  readonly token: string;
  /** Aborted on release, store closure or loss of execution rights. */
  readonly signal: AbortSignal;
  /** Drain earlier writes before releasing; repeated calls are safe. */
  release(): Promise<void>;
}
