import { resolve } from 'node:path';
import {
  ContractError,
  parseJsonValue,
  StoreClosedError,
  StoreError,
} from '@umibe/core';
import type {
  CommitResult,
  RecordCursor,
  RecordPage,
  RunCommit,
  RunLease,
  RunRecord,
  RunStore,
} from '@umibe/core';
import { captureRunCommit } from '@umibe/core/storage-adapter';
import { WorkerChannel } from './channel.js';
import type { SqliteInspection, StoreResults } from './protocol.js';

export type { SqliteInspection } from './protocol.js';

function queryId(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new ContractError(
      'INVALID_STORE_QUERY',
      'store_query',
      path,
      'expected_nonempty_string',
    );
  return value;
}

/** Open explicitly with a database file path. Queries never create a missing database. */
export class SqliteRunStore implements RunStore {
  readonly info: {
    readonly kind: 'sqlite';
    readonly durable: true;
    readonly path: string;
  };
  private readonly channel: WorkerChannel;
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private readonly leases = new Set<AbortController>();
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(path: string) {
    if (typeof path !== 'string' || path.length === 0)
      throw new TypeError('SQLite requires a file path');
    this.info = Object.freeze({
      kind: 'sqlite',
      durable: true,
      path: resolve(path),
    });
    this.channel = new WorkerChannel(this.info.path);
    this.channel.signal.addEventListener(
      'abort',
      () => this.abort(this.channel.signal.reason),
      { once: true },
    );
  }

  private abort(reason: unknown): void {
    this.controller.abort(reason);
    for (const lease of this.leases) lease.abort(reason);
  }

  private ensureOpen(operation: StoreClosedError['operation']): void {
    if (this.closed) throw new StoreClosedError(operation);
    if (this.signal.aborted) throw this.signal.reason;
  }

  async acquireRun(runId: string): Promise<RunLease> {
    this.ensureOpen('acquireRun');
    const id = queryId(runId, '/runId');
    const token = await this.channel.request({ op: 'acquireRun', runId: id });
    const controller = new AbortController();
    this.leases.add(controller);
    if (this.signal.aborted) controller.abort(this.signal.reason);
    let releasing: Promise<void> | undefined;
    return Object.freeze({
      runId: id,
      token,
      signal: controller.signal,
      release: (): Promise<void> => {
        releasing ??= (async () => {
          if (!this.closed && !this.signal.aborted)
            await this.channel.request({ op: 'releaseRun', runId: id, token });
          controller.abort(new StoreError('STORE_OWNERSHIP', 'released'));
          this.leases.delete(controller);
        })();
        return releasing;
      },
    });
  }

  async readRun(runId: string): Promise<StoreResults['readRun']> {
    this.ensureOpen('readRun');
    return this.channel.request({
      op: 'readRun',
      runId: queryId(runId, '/runId'),
    });
  }

  async readRecord(runId: string, eventId: string): Promise<RunRecord | null> {
    this.ensureOpen('readRecord');
    return this.channel.request({
      op: 'readRecord',
      runId: queryId(runId, '/runId'),
      eventId: queryId(eventId, '/eventId'),
    });
  }

  async readRecords(
    runId: string,
    cursor: RecordCursor | null,
    limit: number,
  ): Promise<RecordPage> {
    this.ensureOpen('readRecords');
    const id = queryId(runId, '/runId');
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new ContractError(
        'INVALID_STORE_QUERY',
        'store_query',
        '/limit',
        'expected_positive_integer',
      );
    let sequence = 0;
    if (cursor !== null) {
      const value = parseJsonValue(cursor, 'store_query');
      if (
        typeof value !== 'object' ||
        value === null ||
        Array.isArray(value) ||
        !('runId' in value) ||
        !('sequence' in value) ||
        Object.keys(value).length !== 2
      )
        throw new ContractError(
          'INVALID_STORE_QUERY',
          'store_query',
          '/cursor',
          'invalid_cursor',
        );
      if (queryId(value.runId, '/cursor/runId') !== id)
        throw new ContractError(
          'INVALID_STORE_QUERY',
          'store_query',
          '/cursor/runId',
          'cursor_run_mismatch',
        );
      if (
        typeof value.sequence !== 'number' ||
        !Number.isSafeInteger(value.sequence) ||
        value.sequence < 1
      )
        throw new ContractError(
          'INVALID_STORE_QUERY',
          'store_query',
          '/cursor/sequence',
          'expected_positive_integer',
        );
      sequence = value.sequence;
    }
    return this.channel.request({
      op: 'readRecords',
      runId: id,
      sequence,
      limit,
    });
  }

  async commit(input: RunCommit): Promise<CommitResult> {
    this.ensureOpen('commit');
    const captured = captureRunCommit(input);
    return this.channel.request({ op: 'commit', input: captured });
  }

  async inspect(): Promise<SqliteInspection> {
    this.ensureOpen('readRun');
    return this.channel.request({ op: 'inspect' });
  }

  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.closed = true;
    this.abort(new StoreClosedError('commit'));
    this.closing = this.channel.close();
    return this.closing;
  }
}
