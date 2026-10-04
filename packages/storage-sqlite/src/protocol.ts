import type {
  CommitResult,
  ContractErrorCode,
  RecordPage,
  RunCheckpoint,
  RunCommit,
  RunRecord,
  RunSummary,
  StoreError,
} from '@umibe/core';

export interface SqliteInspection {
  readonly exists: boolean;
  readonly schemaVersion: number | null;
  /** The persisted process claim; a PID alone does not prove Worker health or liveness. */
  readonly owner: { readonly pid: number } | null;
}

export type StoreCommand =
  | {
      readonly op: 'acquireRun';
      readonly runId: string;
      readonly clientId: string;
    }
  | {
      readonly op: 'releaseRun';
      readonly runId: string;
      readonly token: string;
      readonly clientId: string;
    }
  | { readonly op: 'releaseClient'; readonly clientId: string }
  | { readonly op: 'readRun'; readonly runId: string }
  | {
      readonly op: 'readRecord';
      readonly runId: string;
      readonly eventId: string;
    }
  | {
      readonly op: 'readRecords';
      readonly runId: string;
      readonly sequence: number;
      readonly limit: number;
    }
  | {
      readonly op: 'commit';
      readonly input: RunCommit;
      readonly clientId: string;
    }
  | { readonly op: 'inspect' }
  | { readonly op: 'close' };

export interface StoreResults {
  acquireRun: string;
  releaseRun: null;
  releaseClient: null;
  readRun: {
    readonly summary: RunSummary;
    readonly checkpoint: RunCheckpoint;
  } | null;
  readRecord: RunRecord | null;
  readRecords: RecordPage;
  commit: CommitResult;
  inspect: SqliteInspection;
  close: null;
}

export type StoreReply = StoreResults[keyof StoreResults];
export interface StoreRequest {
  readonly id: number;
  readonly command: StoreCommand;
}
export type StoreFailure =
  | {
      readonly type: 'contract';
      readonly code: ContractErrorCode;
      readonly stage: string;
      readonly path: string;
      readonly reason: string;
    }
  | {
      readonly type: 'storage';
      readonly code: StoreError['code'];
      readonly reason: string;
    };
export type StoreResponse =
  | { readonly id: number; readonly ok: true; readonly value: StoreReply }
  | {
      readonly id: number;
      readonly ok: false;
      readonly error: StoreFailure;
      readonly fatal: boolean;
    };
