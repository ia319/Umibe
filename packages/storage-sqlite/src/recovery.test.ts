import { fork } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { SqliteRunStore } from '@umibe/storage-sqlite';
import { runCrashProcess } from '../../umibe/src/__tests__/crash-host.js';

test('rolls back every table after a real process dies inside the production transaction', async () => {
  const path = join(
    mkdtempSync(join(tmpdir(), 'umibe-transaction-crash-')),
    'run.sqlite',
  );
  const child = fork(
    new URL('./__tests__/transaction-process.ts', import.meta.url),
    [path],
    {
      execArgv: [],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  let stderr = '';
  let stopped = false;
  child.once('exit', () => {
    stopped = true;
  });
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<void>((resolve) =>
    child.once('close', () => resolve()),
  );
  let timer: NodeJS.Timeout | undefined;
  try {
    const partial = await new Promise<unknown>((resolve, reject) => {
      child.once('message', resolve);
      child.once('error', reject);
      child.once('exit', (code) =>
        reject(new Error(`Transaction fixture exited with ${code}: ${stderr}`)),
      );
      timer = setTimeout(
        () => reject(new Error(`Transaction boundary not reached: ${stderr}`)),
        10_000,
      );
    });
    expect(partial).toEqual({
      revision: { revision: 2 },
      events: { count: 2 },
      executions: { count: 1 },
      checkpoint: { revision: 1 },
    });
  } finally {
    clearTimeout(timer);
    if (!stopped) child.kill('SIGKILL');
    await exited;
  }
  const raw = new Database(path);
  try {
    expect(
      raw.prepare('SELECT revision, last_sequence FROM runs').get(),
    ).toEqual({ revision: 1, last_sequence: 0 });
    expect(
      raw.prepare('SELECT revision, committed_sequence FROM checkpoints').get(),
    ).toEqual({ revision: 1, committed_sequence: 0 });
    expect(raw.prepare('SELECT * FROM events').all()).toEqual([]);
    expect(raw.prepare('SELECT * FROM action_executions').all()).toEqual([]);
    expect(raw.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(raw.pragma('foreign_key_check')).toEqual([]);
  } finally {
    raw.close();
  }
  const recovered = new SqliteRunStore(path);
  try {
    const lease = await recovered.acquireRun('run');
    expect((await recovered.readRun('run'))?.checkpoint.state).toEqual({
      phase: 'initial',
    });
    await lease.release();
  } finally {
    await recovered.close();
  }
}, 20_000);

test.each([
  'database',
  'schema',
  'checkpoint',
  'application',
  'action',
] as const)(
  'rejects incompatible %s recovery and retains the original database',
  async (kind) => {
    const directory = mkdtempSync(join(tmpdir(), 'umibe-incompatible-'));
    const path = join(directory, 'umibe.sqlite');
    if (kind === 'database')
      writeFileSync(path, 'unknown database bytes', { encoding: 'utf8' });
    else {
      expect(
        await runCrashProcess({
          directory,
          operation: 'start',
          boundary: 'afterIntent',
        }),
      ).toMatchObject({ kind: 'boundary' });
      const raw = new Database(path);
      try {
        if (kind === 'schema')
          raw.exec('UPDATE schema_metadata SET version = 999');
        if (kind === 'checkpoint')
          raw.exec(
            "UPDATE checkpoints SET checkpoint_json = json_set(checkpoint_json, '$.stateSchemaVersion', 999), state_schema_version = 999",
          );
        raw.pragma('wal_checkpoint(TRUNCATE)');
      } finally {
        raw.close();
      }
    }
    // Retain the database and journal bytes; the WAL index is maintained by SQLite readers.
    const paths = [path, `${path}-wal`];
    const before = paths.map((file) =>
      existsSync(file) ? readFileSync(file).toString('base64') : null,
    );
    const result = await runCrashProcess({
      directory,
      operation: 'resume',
      ...(kind === 'application'
        ? { applicationId: 'different-application' }
        : {}),
      ...(kind === 'action' ? { actionVersion: 2 } : {}),
    });
    expect(result.kind).toBe('error');
    expect(result.reason).toBe(
      {
        database: 'SQLITE_NOTADB',
        schema: 'unsupported_schema_version',
        checkpoint: 'unsupported_state_version',
        application: 'identity_mismatch',
        action: 'identity_mismatch',
      }[kind],
    );
    expect(readFileSync(path).toString('base64')).toBe(before[0]);
    // SQLite may create a read-only WAL index; any retained journal still contains the same bytes.
    if (before[1] !== null)
      expect(readFileSync(`${path}-wal`).toString('base64')).toBe(before[1]);
    expect(existsSync(join(directory, 'effects.jsonl'))).toBe(false);
  },
  20_000,
);
