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
  readRun(runId: string): Promise<{
    readonly summary: RunSummary;
    readonly checkpoint: RunCheckpoint;
  } | null>;
  readRecords(
    runId: string,
    cursor: RecordCursor | null,
    limit: number,
  ): Promise<RecordPage>;
  commit(input: RunCommit): Promise<CommitResult>;
  close(): Promise<void>;
}
