import { describe, expect, test } from 'vitest';
import type {
  RunCommit,
  RunRecordDraft,
  RunStore,
  RunLease,
} from '../contracts.js';

const rootGoalRef = { id: 'root', version: 1 };

function coreEvent(runId: string, eventId: string): RunRecordDraft {
  return {
    formatVersion: 1,
    eventId,
    runId,
    kind: 'coreEvent',
    data: {
      source: 'core',
      type: 'checkpoint',
      reasonCode: 'state_changed',
      goalRef: null,
      decisionId: null,
      requestId: null,
      executionId: null,
      details: {},
    },
  };
}

function actionIntent(runId: string, eventId: string): RunRecordDraft {
  return {
    formatVersion: 1,
    eventId,
    runId,
    kind: 'actionIntent',
    data: {
      executionId: 'execution-1',
      decisionId: 'decision-1',
      candidateSetId: 'set-1',
      candidateId: 'candidate-1',
      actionId: 'move',
      actionVersion: 1,
      params: { target: 'north' },
      rootGoalRef,
      currentGoalRef: rootGoalRef,
      goalPathRef: 'path-1',
      planRef: { id: 'plan-1', version: 1, rootGoalVersion: 1 },
      observationRef: { id: 'obs-1', revision: 1 },
      constraintsVersion: 1,
    },
  };
}

function actionResult(runId: string, eventId: string): RunRecordDraft {
  return {
    formatVersion: 1,
    eventId,
    runId,
    kind: 'actionResult',
    data: {
      executionId: 'execution-1',
      outcome: 'unknown',
      reasonCode: 'stop_unconfirmed',
      underlyingSettled: false,
      confirmedEffects: {},
      unresolvedEffects: { position: 'unknown' },
      progress: {},
      stopCauseEventId: null,
    },
  };
}

function commit(
  lease: RunLease,
  expectedRevision: number | null,
  records: readonly RunRecordDraft[],
  state: { phase: string } = { phase: 'running' },
): RunCommit {
  const runId = lease.runId;
  return {
    ownerToken: lease.token,
    runId,
    expectedRevision,
    status: 'running',
    rootGoalRef,
    currentGoalRef: rootGoalRef,
    stateSchemaVersion: 1,
    state,
    records,
  };
}

/** Shared behavioral contract for every RunStore implementation. */
export function runStoreContract(
  name: string,
  createStore: () => Promise<RunStore>,
): void {
  describe(name, () => {
    test('requires a live run lease, rejects duplicate holders and fences released tokens', async () => {
      const store = await createStore();
      const first = await store.acquireRun('run-1');
      await expect(store.acquireRun('run-1')).rejects.toMatchObject({
        code: 'STORE_OWNERSHIP',
        reason: 'run_owned',
      });
      await store.commit(commit(first, null, [coreEvent('run-1', 'event')]));
      expect(await store.readRecord('run-1', 'event')).toMatchObject({
        eventId: 'event',
        sequence: 1,
      });
      expect(await store.readRecord('run-1', 'absent')).toBeNull();
      await first.release();
      expect(first.signal.aborted).toBe(true);
      await first.release();
      const second = await store.acquireRun('run-1');
      expect(second.token).not.toBe(first.token);
      await expect(store.commit(commit(first, 1, []))).rejects.toMatchObject({
        code: 'STORE_OWNERSHIP',
      });
      await store.commit(commit(second, 1, []));
      await store.close();
      expect(second.signal.aborted).toBe(true);
      expect(store.signal.aborted).toBe(true);
    });
    test('commits ordered records with a checkpoint and pages by run-bound cursor', async () => {
      const store = await createStore();
      const firstLease = await store.acquireRun('run-1');
      try {
        const created = await store.commit(
          commit(firstLease, null, [coreEvent('run-1', 'e1')]),
        );
        expect(created.outcome).toBe('committed');
        if (created.outcome !== 'committed') return;
        expect(created.checkpoint.revision).toBe(1);
        expect(created.summary.lastSequence).toBe(1);
        expect(created.records.map((record) => record.sequence)).toEqual([1]);
        expect(created.records[0]?.committedAt).toMatch(/Z$/);

        const updated = await store.commit(
          commit(firstLease, 1, [
            coreEvent('run-1', 'e2'),
            coreEvent('run-1', 'e3'),
          ]),
        );
        expect(updated.outcome).toBe('committed');
        if (updated.outcome !== 'committed') return;
        expect(updated.checkpoint.revision).toBe(2);
        expect(updated.checkpoint.committedSequence).toBe(3);
        const first = await store.readRecords('run-1', null, 2);
        expect(first.records.map((record) => record.eventId)).toEqual([
          'e1',
          'e2',
        ]);
        expect(first.nextCursor).toEqual({ runId: 'run-1', sequence: 2 });
        const last = await store.readRecords('run-1', first.nextCursor, 2);
        expect(last.records.map((record) => record.eventId)).toEqual(['e3']);
        expect(last.nextCursor).toBeNull();
      } finally {
        await store.close();
      }
    });

    test('rejects invalid batches without saving partial records or state', async () => {
      const store = await createStore();
      const firstLease = await store.acquireRun('run-1');
      try {
        await store.commit(
          commit(firstLease, null, [coreEvent('run-1', 'e1')]),
        );
        const invalid = {
          ...commit(firstLease, 1, [
            coreEvent('run-1', 'e2'),
            coreEvent('run-1', 'e3'),
          ]),
          records: [
            coreEvent('run-1', 'e2'),
            { ...coreEvent('run-1', 'e3'), formatVersion: 2 },
          ],
        };
        await expect(store.commit(invalid as RunCommit)).rejects.toMatchObject({
          code: 'INVALID_STORE_COMMIT',
          path: '/records/1/formatVersion',
        });
        expect((await store.readRun('run-1'))?.checkpoint.revision).toBe(1);
        expect(
          (await store.readRecords('run-1', null, 10)).records.map(
            (item) => item.eventId,
          ),
        ).toEqual(['e1']);

        await expect(
          store.commit(commit(firstLease, 1, [coreEvent('run-1', 'e1')])),
        ).rejects.toMatchObject({ reason: 'duplicate_event_id' });
        await expect(
          store.commit(
            commit(firstLease, 1, [
              coreEvent('run-1', 'repeated'),
              coreEvent('run-1', 'repeated'),
            ]),
          ),
        ).rejects.toMatchObject({ reason: 'duplicate_event_id' });
        await expect(
          store.commit(commit(firstLease, 1, [coreEvent('other-run', 'e4')])),
        ).rejects.toMatchObject({ reason: 'cross_run_record' });
        await expect(
          store.commit({
            ...commit(firstLease, 999, [coreEvent('run-1', 'e5')]),
            stateSchemaVersion: 0,
          }),
        ).rejects.toMatchObject({ code: 'INVALID_STORE_COMMIT' });
        expect((await store.readRun('run-1'))?.checkpoint.revision).toBe(1);
      } finally {
        await store.close();
      }
    });

    test('uses revision comparison for creation and concurrent updates', async () => {
      const store = await createStore();
      const firstLease = await store.acquireRun('run-1');
      try {
        expect(await store.commit(commit(firstLease, 1, []))).toEqual({
          outcome: 'conflict',
          actualRevision: null,
        });
        await store.commit(
          commit(firstLease, null, [coreEvent('run-1', 'e1')]),
        );
        const results = await Promise.all([
          store.commit(commit(firstLease, 1, [coreEvent('run-1', 'e2')])),
          store.commit(commit(firstLease, 1, [coreEvent('run-1', 'e3')])),
        ]);
        expect(results.map((result) => result.outcome).sort()).toEqual([
          'committed',
          'conflict',
        ]);
        expect((await store.readRun('run-1'))?.summary.lastSequence).toBe(2);
        expect((await store.readRun('run-1'))?.checkpoint.revision).toBe(2);
        expect(await store.commit(commit(firstLease, null, []))).toEqual({
          outcome: 'conflict',
          actualRevision: 2,
        });
      } finally {
        await store.close();
      }
    });

    test('isolates runs and rejects a cursor from another run', async () => {
      const store = await createStore();
      const firstLease = await store.acquireRun('run-1');
      const secondLease = await store.acquireRun('run-2');
      try {
        await store.commit(
          commit(firstLease, null, [
            coreEvent('run-1', 'same-id'),
            coreEvent('run-1', 'next-id'),
          ]),
        );
        await store.commit(
          commit(secondLease, null, [coreEvent('run-2', 'same-id')]),
        );
        const first = await store.readRecords('run-1', null, 1);
        await expect(
          store.readRecords('run-2', first.nextCursor, 1),
        ).rejects.toMatchObject({ reason: 'cursor_run_mismatch' });
        await expect(
          store.readRecords('run-1', { runId: 'run-1', sequence: 3 }, 1),
        ).rejects.toMatchObject({ reason: 'cursor_ahead_of_run' });
        expect(
          (await store.readRecords('run-2', null, 1)).records[0]?.sequence,
        ).toBe(1);
        const cursor = { runId: 'run-1', sequence: 1 };
        const pendingPage = store.readRecords('run-1', cursor, 1);
        cursor.sequence = 2;
        expect((await pendingPage).records[0]?.eventId).toBe('next-id');
        expect(await store.readRun('missing')).toBeNull();
        expect(await store.readRecords('missing', null, 1)).toEqual({
          records: [],
          nextCursor: null,
        });
      } finally {
        await store.close();
      }
    });

    test('requires action results to follow a recorded intent', async () => {
      const store = await createStore();
      const firstLease = await store.acquireRun('run-1');
      try {
        await expect(
          store.commit(commit(firstLease, null, [actionResult('run-1', 'r1')])),
        ).rejects.toMatchObject({ reason: 'missing_action_intent' });
        await store.commit(
          commit(firstLease, null, [actionIntent('run-1', 'i1')]),
        );
        const completed = await store.commit(
          commit(firstLease, 1, [actionResult('run-1', 'r1')]),
        );
        expect(completed.outcome).toBe('committed');
        await expect(
          store.commit(commit(firstLease, 2, [actionIntent('run-1', 'i2')])),
        ).rejects.toMatchObject({ reason: 'duplicate_execution_id' });
      } finally {
        await store.close();
      }
    });

    test('separates caller mutations and supports a checkpoint-only commit', async () => {
      const store = await createStore();
      const firstLease = await store.acquireRun('run-1');
      try {
        const state = { phase: 'before' };
        const draft = coreEvent('run-1', 'e1');
        const pending = store.commit(commit(firstLease, null, [draft], state));
        state.phase = 'after';
        const created = await pending;
        expect((await store.readRun('run-1'))?.checkpoint.state.phase).toBe(
          'before',
        );
        expect(created.outcome).toBe('committed');
        if (created.outcome !== 'committed') return;
        expect(Object.isFrozen(created.records[0])).toBe(true);
        const page = await store.readRecords('run-1', null, 1);
        expect(Object.isFrozen(page.records)).toBe(true);
        expect(Object.isFrozen(page.records[0]?.data)).toBe(true);
        const updated = await store.commit(
          commit(firstLease, 1, [], { phase: 'checkpoint' }),
        );
        expect(updated.outcome).toBe('committed');
        if (updated.outcome !== 'committed') return;
        expect(updated.checkpoint.revision).toBe(2);
        expect(updated.checkpoint.committedSequence).toBe(1);
        expect(
          (await store.readRecords('run-1', null, 10)).records,
        ).toHaveLength(1);
      } finally {
        await store.close();
      }
    });

    test('closes idempotently and rejects later reads and commits', async () => {
      const store = await createStore();
      const firstLease = await store.acquireRun('run-1');
      await store.commit(commit(firstLease, null, []));
      await store.close();
      await store.close();
      await expect(store.readRun('run-1')).rejects.toMatchObject({
        code: 'STORE_CLOSED',
        operation: 'readRun',
      });
      await expect(store.readRecords('run-1', null, 1)).rejects.toMatchObject({
        code: 'STORE_CLOSED',
        operation: 'readRecords',
      });
      await expect(
        store.commit(commit(firstLease, 1, [])),
      ).rejects.toMatchObject({
        code: 'STORE_CLOSED',
        operation: 'commit',
      });
    });

    test('orders close after pending operations and rejects later calls', async () => {
      const store = await createStore();
      const firstLease = await store.acquireRun('run-1');
      const pending = store.commit(commit(firstLease, null, []));
      const closing = store.close();
      const lateRead = store.readRun('run-1');

      await Promise.all([
        expect(pending).resolves.toMatchObject({ outcome: 'committed' }),
        expect(closing).resolves.toBeUndefined(),
        expect(lateRead).rejects.toMatchObject({ code: 'STORE_CLOSED' }),
      ]);
    });
  });
}
