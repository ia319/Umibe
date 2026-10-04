import { randomUUID } from 'node:crypto';
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
import { canonicalDatabasePath, retainWorker } from './pool.js';
import type {
  SqliteInspection,
  StoreCommand,
  StoreResults,
} from './protocol.js';

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

/**
 * Retain a shared Worker for the canonical file path. Queries never create a missing database.
 * Read, acquisition and commit lock conflicts reject with STORE_BUSY without aborting shared handles or leases.
 * Call close to release this handle's leases and reference; the final reference releases process ownership.
 * A failed Worker never restarts or relinquishes a live process's ownership automatically.
 */
export class SqliteRunStore implements RunStore {
  readonly info: {
    readonly kind: 'sqlite';
    readonly durable: true;
    readonly path: string;
  };
  private readonly clientId = randomUUID();
  private readonly shared: ReturnType<typeof retainWorker>;
  private readonly onFailure = () => this.abort(this.shared.signal.reason);
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private readonly leases = new Set<AbortController>();
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(path: string) {
    this.info = Object.freeze({
      kind: 'sqlite',
      durable: true,
      path: canonicalDatabasePath(path),
    });
    this.shared = retainWorker(this.info.path, this.clientId);
    this.shared.signal.addEventListener('abort', this.onFailure, {
      once: true,
    });
    if (this.shared.signal.aborted) this.onFailure();
  }

  // Register requests in call order even while a prior connection is finishing its close.
  private request<K extends StoreCommand['op']>(
    command: Extract<StoreCommand, { op: K }>,
  ): Promise<StoreResults[K]> {
    return this.shared.ready.then((channel) => channel.request(command));
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
    const token = await this.request({
      op: 'acquireRun',
      runId: id,
      clientId: this.clientId,
    });
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
          controller.abort(new StoreError('STORE_OWNERSHIP', 'released'));
          try {
            if (!this.closed && !this.signal.aborted)
              await this.request({
                op: 'releaseRun',
                runId: id,
                token,
                clientId: this.clientId,
              });
          } finally {
            this.leases.delete(controller);
          }
        })();
        return releasing;
      },
    });
  }

  async readRun(runId: string): Promise<StoreResults['readRun']> {
    this.ensureOpen('readRun');
    return this.request({
      op: 'readRun',
      runId: queryId(runId, '/runId'),
    });
  }

  async readRecord(runId: string, eventId: string): Promise<RunRecord | null> {
    this.ensureOpen('readRecord');
    return this.request({
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
    return this.request({
      op: 'readRecords',
      runId: id,
      sequence,
      limit,
    });
  }

  async commit(input: RunCommit): Promise<CommitResult> {
    this.ensureOpen('commit');
    const captured = captureRunCommit(input);
    return this.request({
      op: 'commit',
      input: captured,
      clientId: this.clientId,
    });
  }

  async inspect(): Promise<SqliteInspection> {
    this.ensureOpen('readRun');
    return this.request({ op: 'inspect' });
  }

  /**
   * Release this handle; the final handle also waits for Worker exit.
   * If the final owner release fails, reject and preserve the process claim;
   * reopening cannot acquire runs while the owning process remains alive.
   */
  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.closed = true;
    this.abort(new StoreClosedError('commit'));
    this.shared.signal.removeEventListener('abort', this.onFailure);
    this.closing = this.shared.release();
    return this.closing;
  }
}
