import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';
import { runStoreContract } from '../../core/src/storage/__tests__/run-store-contract.js';
import { SqliteRunStore } from '@umibe/storage-sqlite';
import { commit, intent, result } from './__tests__/fixtures.js';

const directory = mkdtempSync(join(tmpdir(), 'umibe-sqlite-test-'));
let counter = 0;
const stores = new Set<SqliteRunStore>();
function store(path = join(directory, `${++counter}.sqlite`)): SqliteRunStore {
  const instance = new SqliteRunStore(path);
  stores.add(instance);
  return instance;
}
afterEach(async () => {
  await Promise.all([...stores].map((item) => item.close()));
  stores.clear();
});

runStoreContract('SqliteRunStore', () => Promise.resolve(store()));

describe('SQLite transactions', () => {
  test('leaves missing paths untouched during construction and queries', async () => {
    const database = store();
    expect(existsSync(database.info.path)).toBe(false);
    expect(await database.inspect()).toEqual({
      exists: false,
      schemaVersion: null,
      owner: null,
    });
    expect(await database.readRun('absent')).toBeNull();
    expect(await database.readRecord('absent', 'event')).toBeNull();
    expect(await database.readRecords('absent', null, 1)).toEqual({
      records: [],
      nextCursor: null,
    });
    await database.close();
    expect(existsSync(database.info.path)).toBe(false);
  });

  test('persists records, execution indices and checkpoints across reopen', async () => {
    const database = store();
    const lease = await database.acquireRun('run');
    await database.commit(commit(lease, null, [intent('run'), result('run')]));
    const path = database.info.path;
    const raw = new Database(path, { readonly: true });
    try {
      expect(raw.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(
        raw
          .prepare(
            'SELECT run_id, execution_id, intent_sequence, result_sequence FROM action_executions',
          )
          .get(),
      ).toEqual({
        run_id: 'run',
        execution_id: 'execution',
        intent_sequence: 1,
        result_sequence: 2,
      });
      expect(raw.pragma('foreign_key_check')).toEqual([]);
    } finally {
      raw.close();
    }
    await database.close();
    const reopened = store(path);
    expect((await reopened.readRun('run'))?.checkpoint).toMatchObject({
      revision: 1,
      committedSequence: 2,
    });
    expect(
      (await reopened.readRecords('run', null, 10)).records.map(
        (item) => item.kind,
      ),
    ).toEqual(['actionIntent', 'actionResult']);
    expect(await reopened.readRecord('run', 'result')).toMatchObject({
      kind: 'actionResult',
      sequence: 2,
    });
  });

  test('rolls back earlier SQL writes when the final checkpoint write fails', async () => {
    const database = store();
    const lease = await database.acquireRun('run');
    await database.commit(commit(lease, null));
    const raw = new Database(database.info.path);
    try {
      raw.exec(
        "CREATE TRIGGER fail_checkpoint BEFORE UPDATE ON checkpoints BEGIN SELECT RAISE(ABORT, 'injected failure'); END;",
      );
      await expect(
        database.commit(commit(lease, 1, [intent('run'), result('run')])),
      ).rejects.toMatchObject({ code: 'STORE_FAILED' });
      expect(database.signal.aborted).toBe(true);
      expect(lease.signal.aborted).toBe(true);
      expect(
        raw.prepare('SELECT revision, last_sequence FROM runs').get(),
      ).toEqual({ revision: 1, last_sequence: 0 });
      expect(
        raw
          .prepare('SELECT revision, committed_sequence FROM checkpoints')
          .get(),
      ).toEqual({ revision: 1, committed_sequence: 0 });
      expect(raw.prepare('SELECT * FROM events').all()).toEqual([]);
      expect(raw.prepare('SELECT * FROM action_executions').all()).toEqual([]);
    } finally {
      raw.close();
    }
  });

  test('rejects an unsupported schema without changing the database', async () => {
    const database = store();
    await database.acquireRun('run');
    await database.close();
    const raw = new Database(database.info.path);
    raw.exec('UPDATE schema_metadata SET version = 999');
    raw.close();
    const before = readFileSync(database.info.path);
    const reopened = store(database.info.path);
    await expect(reopened.acquireRun('run')).rejects.toMatchObject({
      code: 'STORE_VERSION',
    });
    expect(readFileSync(database.info.path)).toEqual(before);
  });

  test('preserves a file that is not a SQLite database', async () => {
    const path = join(directory, 'invalid.sqlite');
    writeFileSync(path, 'not a database', { encoding: 'utf8' });
    const database = store(path);
    await expect(database.readRun('run')).rejects.toMatchObject({
      code: 'STORE_CORRUPT',
    });
    expect(readFileSync(path, 'utf8')).toBe('not a database');
  });
});
