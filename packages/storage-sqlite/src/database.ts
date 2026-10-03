import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import {
  ContractError,
  parseRunCheckpoint,
  parseRunRecord,
  parseRunSummary,
  StoreError,
} from '@umibe/core';
import type { CommitResult, RunCommit, RunRecord } from '@umibe/core';
import { prepareRunCommit } from '@umibe/core/storage-adapter';
import type { SqliteInspection, StoreResults } from './protocol.js';

const schemaVersion = 1;
const schema = `
CREATE TABLE schema_metadata (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL);
INSERT INTO schema_metadata VALUES (1, 1);
CREATE TABLE runtime_owner (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), pid INTEGER NOT NULL CHECK (pid > 0), token TEXT NOT NULL);
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK (revision > 0),
  last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0), summary_json TEXT NOT NULL CHECK (json_valid(summary_json))
);
CREATE TABLE events (
  run_id TEXT NOT NULL REFERENCES runs(run_id), sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_id TEXT NOT NULL, kind TEXT NOT NULL, record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  PRIMARY KEY (run_id, sequence), UNIQUE (run_id, event_id)
);
CREATE TABLE action_executions (
  run_id TEXT NOT NULL REFERENCES runs(run_id), execution_id TEXT NOT NULL, intent_sequence INTEGER NOT NULL, result_sequence INTEGER,
  PRIMARY KEY (run_id, execution_id),
  FOREIGN KEY (run_id, intent_sequence) REFERENCES events(run_id, sequence),
  FOREIGN KEY (run_id, result_sequence) REFERENCES events(run_id, sequence)
);
CREATE TABLE checkpoints (
  run_id TEXT PRIMARY KEY REFERENCES runs(run_id), revision INTEGER NOT NULL CHECK (revision > 0),
  committed_sequence INTEGER NOT NULL CHECK (committed_sequence >= 0), state_schema_version INTEGER NOT NULL CHECK (state_schema_version > 0),
  checkpoint_json TEXT NOT NULL CHECK (json_valid(checkpoint_json))
);`;

interface StoredRunRow {
  revision: number;
  last_sequence: number;
  summary_json: string;
  checkpoint_json: string;
}

function decodeStored<T>(decode: () => T): T {
  try {
    return decode();
  } catch (error) {
    if (error instanceof ContractError || error instanceof SyntaxError)
      throw new StoreError('STORE_CORRUPT', 'invalid_persisted_data', {
        cause: error,
      });
    throw error;
  }
}

/** Owns the SQLite connection; instantiate only inside the storage Worker. */
export class RunDatabase {
  private db: Database.Database | undefined;
  private readonly leases = new Map<string, string>();

  constructor(private readonly path: string) {}

  private open(write: boolean): Database.Database | undefined {
    if (this.db !== undefined && (!write || !this.db.readonly)) return this.db;
    if (this.db !== undefined) {
      this.db.close();
      this.db = undefined;
    }
    const existed = existsSync(this.path);
    if (!write && !existed) return undefined;
    const db = new Database(this.path, {
      readonly: !write,
      fileMustExist: !write,
      timeout: 5000,
    });
    try {
      db.pragma('foreign_keys = ON');
      if (existed) this.validateSchema(db);
      if (write) {
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = FULL');
        if (!existed) db.transaction(() => db.exec(schema)).immediate();
      }
      this.db = db;
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private validateSchema(db: Database.Database): void {
    const table = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'schema_metadata'",
      )
      .get();
    if (table === undefined)
      throw new StoreError('STORE_CORRUPT', 'unknown_database_format');
    const metadata = db
      .prepare<[], { version: number }>(
        'SELECT version FROM schema_metadata WHERE singleton = 1',
      )
      .get();
    if (metadata === undefined)
      throw new StoreError('STORE_CORRUPT', 'missing_schema_version');
    if (metadata.version !== schemaVersion)
      throw new StoreError('STORE_VERSION', 'unsupported_schema_version');
    for (const name of [
      'runs',
      'events',
      'action_executions',
      'checkpoints',
      'runtime_owner',
    ]) {
      if (
        db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?",
          )
          .get(name) === undefined
      )
        throw new StoreError('STORE_CORRUPT', 'missing_table');
    }
  }

  acquireRun(runId: string): string {
    this.open(true);
    if (this.leases.has(runId))
      throw new StoreError('STORE_OWNERSHIP', 'run_owned');
    const token = randomUUID();
    this.leases.set(runId, token);
    return token;
  }

  releaseRun(runId: string, token: string): null {
    if (this.leases.get(runId) !== token)
      throw new StoreError('STORE_OWNERSHIP', 'invalid_owner');
    this.leases.delete(runId);
    return null;
  }

  private readRow(
    db: Database.Database,
    runId: string,
  ): StoredRunRow | undefined {
    return db
      .prepare<[string], StoredRunRow>(
        'SELECT r.revision, r.last_sequence, r.summary_json, c.checkpoint_json FROM runs r LEFT JOIN checkpoints c ON c.run_id = r.run_id WHERE r.run_id = ?',
      )
      .get(runId);
  }

  readRun(runId: string): StoreResults['readRun'] {
    const db = this.open(false);
    if (db === undefined) return null;
    const row = this.readRow(db, runId);
    if (row === undefined) return null;
    const summary = decodeStored(() =>
      parseRunSummary(JSON.parse(row.summary_json)),
    );
    const checkpoint = decodeStored(() =>
      parseRunCheckpoint(JSON.parse(row.checkpoint_json)),
    );
    if (
      summary.runId !== runId ||
      checkpoint.runId !== runId ||
      summary.checkpointRevision !== row.revision ||
      checkpoint.revision !== row.revision ||
      summary.lastSequence !== row.last_sequence ||
      checkpoint.committedSequence !== row.last_sequence ||
      checkpoint.status !== summary.status
    )
      throw new StoreError('STORE_CORRUPT', 'inconsistent_checkpoint');
    return { summary, checkpoint };
  }

  readRecord(runId: string, eventId: string): RunRecord | null {
    const db = this.open(false);
    const row = db
      ?.prepare<[string, string], { record_json: string }>(
        'SELECT record_json FROM events WHERE run_id = ? AND event_id = ?',
      )
      .get(runId, eventId);
    return row === undefined
      ? null
      : decodeStored(() => parseRunRecord(JSON.parse(row.record_json)));
  }

  readRecords(
    runId: string,
    sequence: number,
    limit: number,
  ): StoreResults['readRecords'] {
    const db = this.open(false);
    if (db === undefined) {
      if (sequence > 0)
        throw new ContractError(
          'INVALID_STORE_QUERY',
          'store_query',
          '/cursor',
          'cursor_run_missing',
        );
      return { records: [], nextCursor: null };
    }
    // A reader in another process can observe commits; keep the page and its end marker in one snapshot.
    return db.transaction(() => {
      const row = this.readRow(db, runId);
      if (row === undefined) {
        if (sequence > 0)
          throw new ContractError(
            'INVALID_STORE_QUERY',
            'store_query',
            '/cursor',
            'cursor_run_missing',
          );
        return { records: [], nextCursor: null };
      }
      if (sequence > row.last_sequence)
        throw new ContractError(
          'INVALID_STORE_QUERY',
          'store_query',
          '/cursor/sequence',
          'cursor_ahead_of_run',
        );
      const records = db
        .prepare<[string, number, number], { record_json: string }>(
          'SELECT record_json FROM events WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?',
        )
        .all(runId, sequence, limit)
        .map((entry) =>
          decodeStored(() => parseRunRecord(JSON.parse(entry.record_json))),
        );
      const last = records.at(-1);
      return {
        records,
        nextCursor:
          last !== undefined && last.sequence < row.last_sequence
            ? { runId, sequence: last.sequence }
            : null,
      };
    })();
  }

  commit(input: RunCommit): CommitResult {
    if (this.leases.get(input.runId) !== input.ownerToken)
      throw new StoreError('STORE_OWNERSHIP', 'invalid_owner');
    const db = this.open(true);
    if (db === undefined)
      throw new StoreError('STORE_FAILED', 'database_not_open');
    return db
      .transaction(() => {
        const current = this.readRow(db, input.runId);
        const result = prepareRunCommit(input, {
          revision: current?.revision ?? null,
          lastSequence: current?.last_sequence ?? 0,
          hasEvent: (id) =>
            db
              .prepare('SELECT 1 FROM events WHERE run_id = ? AND event_id = ?')
              .get(input.runId, id) !== undefined,
          hasIntent: (id) =>
            db
              .prepare(
                'SELECT 1 FROM action_executions WHERE run_id = ? AND execution_id = ?',
              )
              .get(input.runId, id) !== undefined,
        });
        if (result.outcome === 'conflict') return result;
        db.prepare(
          'INSERT INTO runs (run_id, revision, last_sequence, summary_json) VALUES (?, ?, ?, ?) ON CONFLICT (run_id) DO UPDATE SET revision = excluded.revision, last_sequence = excluded.last_sequence, summary_json = excluded.summary_json',
        ).run(
          input.runId,
          result.checkpoint.revision,
          result.summary.lastSequence,
          JSON.stringify(result.summary),
        );
        for (const record of result.records) {
          db.prepare(
            'INSERT INTO events (run_id, sequence, event_id, kind, record_json) VALUES (?, ?, ?, ?, ?)',
          ).run(
            input.runId,
            record.sequence,
            record.eventId,
            record.kind,
            JSON.stringify(record),
          );
          if (record.kind === 'actionIntent')
            db.prepare(
              'INSERT INTO action_executions (run_id, execution_id, intent_sequence) VALUES (?, ?, ?)',
            ).run(input.runId, record.data.executionId, record.sequence);
          if (record.kind === 'actionResult')
            db.prepare(
              'UPDATE action_executions SET result_sequence = ? WHERE run_id = ? AND execution_id = ?',
            ).run(record.sequence, input.runId, record.data.executionId);
        }
        db.prepare(
          'INSERT INTO checkpoints (run_id, revision, committed_sequence, state_schema_version, checkpoint_json) VALUES (?, ?, ?, ?, ?) ON CONFLICT (run_id) DO UPDATE SET revision = excluded.revision, committed_sequence = excluded.committed_sequence, state_schema_version = excluded.state_schema_version, checkpoint_json = excluded.checkpoint_json',
        ).run(
          input.runId,
          result.checkpoint.revision,
          result.checkpoint.committedSequence,
          input.stateSchemaVersion,
          JSON.stringify(result.checkpoint),
        );
        return result;
      })
      .immediate();
  }

  inspect(): SqliteInspection {
    const db = this.open(false);
    if (db === undefined)
      return { exists: false, schemaVersion: null, owner: null };
    const owner = db
      .prepare<[], { pid: number }>(
        'SELECT pid FROM runtime_owner WHERE singleton = 1',
      )
      .get();
    return { exists: true, schemaVersion, owner: owner ?? null };
  }

  close(): null {
    this.db?.close();
    this.db = undefined;
    this.leases.clear();
    return null;
  }
}
