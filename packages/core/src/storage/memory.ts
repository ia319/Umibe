import { randomUUID } from 'node:crypto';
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
import { parseJsonValue } from '../validation/json.js';
import { captureRunCommit, prepareRunCommit } from './adapter.js';
import type {
  CommitResult,
  RecordCursor,
  RecordPage,
  RunCommit,
  RunStore,
  RunLease,
} from './contracts.js';
import { StoreClosedError, StoreError } from './errors.js';

interface StoredRun {
  summary: RunSummary;
  checkpoint: RunCheckpoint;
  readonly records: RunRecord[];
  readonly eventIds: Set<string>;
  readonly intentIds: Set<string>;
}

const queryContext: FieldContext = {
  code: 'INVALID_STORE_QUERY',
  stage: 'store_query',
};

/** Operations run in call order; synchronous Promise executors also isolate inputs before returning. */
export class MemoryRunStore implements RunStore {
  readonly info = Object.freeze({ kind: 'memory', durable: false, path: null });
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private readonly leases = new Map<
    string,
    { token: string; controller: AbortController }
  >();
  private readonly runs = new Map<string, StoredRun>();
  private closed = false;

  acquireRun(runId: string): Promise<RunLease> {
    return new Promise((resolve) => {
      this.ensureOpen('acquireRun');
      const id = requireString(runId, queryContext, '/runId');
      if (this.leases.has(id))
        throw new StoreError('STORE_OWNERSHIP', 'run_owned');
      const lease = { token: randomUUID(), controller: new AbortController() };
      this.leases.set(id, lease);
      resolve(
        Object.freeze({
          runId: id,
          token: lease.token,
          signal: lease.controller.signal,
          release: () => {
            if (this.leases.get(id) === lease) this.leases.delete(id);
            lease.controller.abort(
              new StoreError('STORE_OWNERSHIP', 'released'),
            );
            return Promise.resolve();
          },
        }),
      );
    });
  }

  readRecord(runId: string, eventId: string): Promise<RunRecord | null> {
    return new Promise((resolve) => {
      this.ensureOpen('readRecord');
      const id = requireString(runId, queryContext, '/runId');
      const event = requireString(eventId, queryContext, '/eventId');
      resolve(
        this.runs.get(id)?.records.find((record) => record.eventId === event) ??
          null,
      );
    });
  }

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
      const captured = captureRunCommit(input);
      const runId = captured.runId;
      if (this.leases.get(runId)?.token !== captured.ownerToken)
        throw new StoreError('STORE_OWNERSHIP', 'invalid_owner');
      const current = this.runs.get(runId);
      const result = prepareRunCommit(captured, {
        revision: current?.checkpoint.revision ?? null,
        lastSequence: current?.summary.lastSequence ?? 0,
        hasEvent: (id) => current?.eventIds.has(id) ?? false,
        hasIntent: (id) => current?.intentIds.has(id) ?? false,
      });
      if (result.outcome === 'committed') {
        const stored = current ?? {
          summary: result.summary,
          checkpoint: result.checkpoint,
          records: [],
          eventIds: new Set<string>(),
          intentIds: new Set<string>(),
        };
        for (const record of result.records) {
          stored.records.push(record);
          stored.eventIds.add(record.eventId);
          if (record.kind === 'actionIntent')
            stored.intentIds.add(record.data.executionId);
        }
        stored.summary = result.summary;
        stored.checkpoint = result.checkpoint;
        this.runs.set(runId, stored);
      }
      resolve(result);
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.closed) {
        this.closed = true;
        this.controller.abort(new StoreClosedError('commit'));
        for (const lease of this.leases.values())
          lease.controller.abort(new StoreClosedError('commit'));
        this.leases.clear();
        this.runs.clear();
      }
      resolve();
    });
  }

  private ensureOpen(operation: StoreClosedError['operation']): void {
    if (this.closed) throw new StoreClosedError(operation);
  }
}
