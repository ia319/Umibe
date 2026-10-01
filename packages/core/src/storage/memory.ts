import type {
  RunCheckpoint,
  RunRecord,
  RunSummary,
} from '../contracts/record.js';
import { ContractError } from '../errors.js';
import {
  requireInteger,
  requireKeys,
  requireObject,
  requireString,
} from '../validation/fields.js';
import type { FieldContext } from '../validation/fields.js';
import { isJsonArray, parseJsonValue } from '../validation/json.js';
import {
  parseRunCheckpoint,
  parseRunRecord,
  parseRunSummary,
} from '../validation/record.js';
import type {
  CommitResult,
  RecordCursor,
  RecordPage,
  RunCommit,
  RunStore,
} from './contracts.js';
import { StoreClosedError } from './errors.js';

interface StoredRun {
  summary: RunSummary;
  checkpoint: RunCheckpoint;
  readonly records: RunRecord[];
  readonly eventIds: Set<string>;
  readonly intentIds: Set<string>;
}

const commitContext: FieldContext = {
  code: 'INVALID_STORE_COMMIT',
  stage: 'store_commit',
};
const queryContext: FieldContext = {
  code: 'INVALID_STORE_QUERY',
  stage: 'store_query',
};

function invalid(path: string, reason: string): never {
  throw new ContractError(
    commitContext.code,
    commitContext.stage,
    path,
    reason,
  );
}

/** Operations run in call order; synchronous Promise executors also isolate inputs before returning. */
export class MemoryRunStore implements RunStore {
  private readonly runs = new Map<string, StoredRun>();
  private closed = false;

  readRun(runId: string): Promise<{
    readonly summary: RunSummary;
    readonly checkpoint: RunCheckpoint;
  } | null> {
    return new Promise((resolve) => {
      this.ensureOpen('readRun');
      const id = requireString(runId, queryContext, '/runId');
      const run = this.runs.get(id);
      resolve(
        run === undefined
          ? null
          : Object.freeze({ summary: run.summary, checkpoint: run.checkpoint }),
      );
    });
  }

  readRecords(
    runId: string,
    cursor: RecordCursor | null,
    limit: number,
  ): Promise<RecordPage> {
    return new Promise((resolve) => {
      this.ensureOpen('readRecords');
      const id = requireString(runId, queryContext, '/runId');
      const size = requireInteger(limit, 1, queryContext, '/limit');
      let sequence = 0;
      if (cursor !== null) {
        const value = requireObject(
          parseJsonValue(cursor, queryContext.stage),
          queryContext,
          '/cursor',
        );
        requireKeys(value, ['runId', 'sequence'], queryContext, '/cursor');
        if (requireString(value.runId, queryContext, '/cursor/runId') !== id) {
          throw new ContractError(
            queryContext.code,
            queryContext.stage,
            '/cursor/runId',
            'cursor_run_mismatch',
          );
        }
        sequence = requireInteger(
          value.sequence,
          1,
          queryContext,
          '/cursor/sequence',
        );
      }
      const run = this.runs.get(id);
      if (run === undefined) {
        if (cursor !== null) {
          throw new ContractError(
            queryContext.code,
            queryContext.stage,
            '/cursor',
            'cursor_run_missing',
          );
        }
        resolve(
          Object.freeze({ records: Object.freeze([]), nextCursor: null }),
        );
        return;
      }
      if (sequence > run.summary.lastSequence) {
        throw new ContractError(
          queryContext.code,
          queryContext.stage,
          '/cursor/sequence',
          'cursor_ahead_of_run',
        );
      }
      const records = Object.freeze(
        run.records.slice(sequence, sequence + size),
      );
      const last = records.at(-1);
      const nextCursor =
        last !== undefined && last.sequence < run.summary.lastSequence
          ? Object.freeze({ runId: id, sequence: last.sequence })
          : null;
      resolve(Object.freeze({ records, nextCursor }));
    });
  }

  commit(input: RunCommit): Promise<CommitResult> {
    return new Promise((resolve) => {
      this.ensureOpen('commit');
      const value = requireObject(
        parseJsonValue(input, commitContext.stage),
        commitContext,
        '',
      );
      requireKeys(
        value,
        [
          'runId',
          'expectedRevision',
          'status',
          'rootGoalRef',
          'currentGoalRef',
          'stateSchemaVersion',
          'state',
          'records',
        ],
        commitContext,
        '',
      );
      const runId = requireString(value.runId, commitContext, '/runId');
      const expectedRevision =
        value.expectedRevision === null
          ? null
          : requireInteger(
              value.expectedRevision,
              1,
              commitContext,
              '/expectedRevision',
            );
      const current = this.runs.get(runId);
      const actualRevision = current?.checkpoint.revision ?? null;
      const revision = (actualRevision ?? 0) + 1;
      const committedAt = new Date().toISOString();
      const entries = value.records;
      if (!isJsonArray(entries)) invalid('/records', 'expected_array');
      const newEventIds = new Set<string>();
      const newIntentIds = new Set<string>();
      const records: RunRecord[] = [];
      for (const [index, entry] of entries.entries()) {
        const path = `/records/${index}`;
        const draft = requireObject(entry, commitContext, path);
        requireKeys(
          draft,
          ['formatVersion', 'eventId', 'runId', 'kind', 'data'],
          commitContext,
          path,
        );
        if (draft.runId !== runId) invalid(`${path}/runId`, 'cross_run_record');
        const eventId = requireString(
          draft.eventId,
          commitContext,
          `${path}/eventId`,
        );
        if (current?.eventIds.has(eventId) || newEventIds.has(eventId)) {
          invalid(`${path}/eventId`, 'duplicate_event_id');
        }
        let record: RunRecord;
        try {
          record = parseRunRecord({
            ...draft,
            sequence: (current?.summary.lastSequence ?? 0) + index + 1,
            committedAt,
          });
        } catch (error) {
          if (error instanceof ContractError) {
            invalid(`${path}${error.path}`, error.reason);
          }
          throw error;
        }
        if (record.kind === 'actionIntent') {
          if (
            current?.intentIds.has(record.data.executionId) ||
            newIntentIds.has(record.data.executionId)
          ) {
            invalid(`${path}/data/executionId`, 'duplicate_execution_id');
          }
          newIntentIds.add(record.data.executionId);
        }
        if (
          record.kind === 'actionResult' &&
          !current?.intentIds.has(record.data.executionId) &&
          !newIntentIds.has(record.data.executionId)
        ) {
          invalid(`${path}/data/executionId`, 'missing_action_intent');
        }
        newEventIds.add(eventId);
        records.push(record);
      }
      let summary: RunSummary;
      let checkpoint: RunCheckpoint;
      try {
        summary = parseRunSummary({
          formatVersion: 1,
          runId,
          status: value.status,
          rootGoalRef: value.rootGoalRef,
          currentGoalRef: value.currentGoalRef,
          lastSequence: (current?.summary.lastSequence ?? 0) + records.length,
          lastActivityAt: committedAt,
          checkpointRevision: revision,
        });
        checkpoint = parseRunCheckpoint({
          formatVersion: 1,
          runId,
          revision,
          committedSequence: summary.lastSequence,
          status: summary.status,
          stateSchemaVersion: value.stateSchemaVersion,
          state: value.state,
        });
      } catch (error) {
        if (error instanceof ContractError) invalid(error.path, error.reason);
        throw error;
      }
      if (expectedRevision !== actualRevision) {
        resolve(Object.freeze({ outcome: 'conflict', actualRevision }));
        return;
      }
      if (current === undefined) {
        this.runs.set(runId, {
          summary,
          checkpoint,
          records,
          eventIds: newEventIds,
          intentIds: newIntentIds,
        });
      } else {
        // All validation and conflict checks finish before any shared state changes.
        for (const record of records) current.records.push(record);
        for (const eventId of newEventIds) current.eventIds.add(eventId);
        for (const intentId of newIntentIds) current.intentIds.add(intentId);
        current.summary = summary;
        current.checkpoint = checkpoint;
      }
      resolve(
        Object.freeze({
          outcome: 'committed',
          summary,
          checkpoint,
          records: Object.freeze([...records]),
        }),
      );
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.closed) {
        this.closed = true;
        this.runs.clear();
      }
      resolve();
    });
  }

  private ensureOpen(operation: StoreClosedError['operation']): void {
    if (this.closed) throw new StoreClosedError(operation);
  }
}
