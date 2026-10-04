import Database from 'better-sqlite3';
import { RunDatabase } from '#internal/database';
import type { RunCommit } from '@umibe/core';

const path = process.argv[2];
if (path === undefined) throw new Error('A database path is required');
const database = new RunDatabase(path);
const ownerToken = database.acquireRun('run', 'fixture');
const initial: RunCommit = {
  ownerToken,
  runId: 'run',
  expectedRevision: null,
  status: 'running',
  rootGoalRef: { id: 'root', version: 1 },
  currentGoalRef: { id: 'root', version: 1 },
  stateSchemaVersion: 1,
  state: { phase: 'initial' },
  records: [],
};
database.commit(initial, 'fixture');

// Install a connection-local test trigger; use the compiled production transaction unchanged.
const connection: unknown = Reflect.get(database, 'db');
if (!(connection instanceof Database))
  throw new Error('Missing fixture connection');
connection.function(
  'crash_boundary',
  (
    revision: unknown,
    events: unknown,
    executions: unknown,
    checkpoint: unknown,
  ) => {
    process.send?.({
      revision: { revision },
      events: { count: events },
      executions: { count: executions },
      checkpoint: { revision: checkpoint },
    });
    // Block inside SQLite while the parent ends this host, without unwinding or rolling back in JS.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    throw new Error('The host must be killed at the transaction boundary');
  },
);
connection.exec(
  'CREATE TEMP TRIGGER interrupt_checkpoint BEFORE UPDATE ON checkpoints BEGIN SELECT crash_boundary((SELECT revision FROM runs), (SELECT COUNT(*) FROM events), (SELECT COUNT(*) FROM action_executions), OLD.revision); END',
);
database.commit(
  {
    ...initial,
    expectedRevision: 1,
    state: { phase: 'partial' },
    records: [
      {
        formatVersion: 1,
        eventId: 'intent',
        runId: 'run',
        kind: 'actionIntent',
        data: {
          executionId: 'execution',
          decisionId: 'decision',
          candidateSetId: 'set',
          candidateId: 'candidate',
          actionId: 'sample',
          actionVersion: 1,
          params: {},
          rootGoalRef: { id: 'root', version: 1 },
          currentGoalRef: { id: 'root', version: 1 },
          goalPathRef: 'path',
          planRef: { id: 'plan', version: 1, rootGoalVersion: 1 },
          observationRef: { id: 'observation', revision: 1 },
          constraintsVersion: 1,
        },
      },
      {
        formatVersion: 1,
        eventId: 'result',
        runId: 'run',
        kind: 'actionResult',
        data: {
          executionId: 'execution',
          outcome: 'succeeded',
          reasonCode: 'done',
          underlyingSettled: true,
          confirmedEffects: {},
          unresolvedEffects: {},
          progress: {},
          stopCauseEventId: null,
        },
      },
    ],
  },
  'fixture',
);
