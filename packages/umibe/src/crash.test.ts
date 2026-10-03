import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { SqliteRunStore } from '@umibe/storage-sqlite';
import { parseRuntimeCheckpoint } from '@umibe/core';
import { runCrashProcess } from './__tests__/crash-host.js';

function readEffects(root: string) {
  const path = join(root, 'effects.jsonl');
  return existsSync(path)
    ? readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .map((line) =>
          z
            .strictObject({
              executionId: z.string(),
              depth: z.number(),
              goal: z.string(),
              parameter: z.number(),
            })
            .parse(JSON.parse(line)),
        )
    : [];
}

async function snapshot(root: string) {
  const store = new SqliteRunStore(join(root, 'umibe.sqlite'));
  try {
    const run = await store.readRun('run');
    expect(run).not.toBeNull();
    return {
      ...run!,
      state: parseRuntimeCheckpoint(run!.checkpoint).state,
      records: (await store.readRecords('run', null, 1000)).records,
    };
  } finally {
    await store.close();
  }
}

test.each([
  'beforeIntent',
  'afterIntent',
  'afterEffect',
  'afterResult',
  'beforeProgress',
  'afterProgress',
] as const)(
  'recovers a host killed at %s without replaying a completed external effect',
  async (boundary) => {
    const root = mkdtempSync(join(tmpdir(), 'umibe-crash-'));
    expect(
      await runCrashProcess({ directory: root, operation: 'start', boundary }),
    ).toEqual({ kind: 'boundary', boundary });
    const before = await snapshot(root);
    expect(readEffects(root)).toHaveLength(
      boundary === 'beforeIntent' || boundary === 'afterIntent' ? 0 : 1,
    );
    expect(
      before.records.filter((record) => record.kind === 'actionIntent'),
    ).toHaveLength(boundary === 'beforeIntent' ? 0 : 1);
    expect(
      await runCrashProcess({
        directory: root,
        operation: 'resume',
        ...(boundary === 'afterEffect' ? { parameterDefault: 999 } : {}),
      }),
    ).toMatchObject({ kind: 'done', status: 'succeeded' });
    const after = await snapshot(root);
    const effects = readEffects(root);
    expect(effects).toHaveLength(1);
    expect(after.state.progressAttempt).toBeNull();
    expect(after.state.actionAttempts).toBe(boundary === 'afterIntent' ? 2 : 1);
    const progress = after.records.flatMap((record) =>
      record.kind === 'coreEvent' &&
      record.data.type === 'progress_assessed' &&
      record.data.reasonCode === 'action'
        ? [record.data]
        : [],
    );
    expect(progress).toHaveLength(boundary === 'afterIntent' ? 2 : 1);
    expect(new Set(progress.map((record) => record.executionId)).size).toBe(
      progress.length,
    );
    expect(progress.at(-1)).toMatchObject({
      executionId: effects[0]!.executionId,
    });
    const reconciled = boundary === 'afterIntent' || boundary === 'afterEffect';
    expect(existsSync(join(root, 'reconciliations.jsonl'))).toBe(reconciled);
    if (reconciled) {
      const entries = readFileSync(join(root, 'reconciliations.jsonl'), 'utf8')
        .trim()
        .split('\n');
      expect(entries).toHaveLength(1);
      expect(JSON.parse(entries[0]!)).toMatchObject({ params: { value: 7 } });
    }
    if (boundary === 'afterIntent') {
      const intents = after.records.filter(
        (record) => record.kind === 'actionIntent',
      );
      expect(
        after.records.some(
          (record) =>
            record.kind === 'coreEvent' &&
            record.data.details.retryOf === intents[0]?.data.executionId,
        ),
      ).toBe(true);
    }
  },
  20_000,
);

test.each(['unknown', 'missing'] as const)(
  'keeps a crashed execution blocked when reconciliation is %s',
  async (reconcile) => {
    const root = mkdtempSync(join(tmpdir(), 'umibe-crash-'));
    expect(
      await runCrashProcess({
        directory: root,
        operation: 'start',
        boundary: 'afterIntent',
      }),
    ).toMatchObject({ kind: 'boundary' });
    expect(
      await runCrashProcess({
        directory: root,
        operation: 'resume',
        reconcile,
      }),
    ).toMatchObject({ kind: 'error', reason: 'execution_unsettled' });
    const recovered = await snapshot(root);
    expect(recovered.summary.status).toBe('paused');
    expect(recovered.state.execution?.phase).toBe('unknown');
    expect(recovered.state.actionAttempts).toBe(1);
    expect(readEffects(root)).toEqual([]);
  },
  20_000,
);

test.each(['beforeProgress', 'afterProgress'] as const)(
  'settles no-progress once when the host dies at %s',
  async (boundary) => {
    const root = mkdtempSync(join(tmpdir(), 'umibe-crash-'));
    expect(
      await runCrashProcess({
        directory: root,
        operation: 'start',
        target: 10,
        boundary,
      }),
    ).toEqual({ kind: 'boundary', boundary });
    expect(
      await runCrashProcess({ directory: root, operation: 'resume' }),
    ).toMatchObject({ kind: 'done', status: 'paused' });
    const recovered = await snapshot(root);
    expect(recovered.state.progressAttempt).toBeNull();
    expect(recovered.state.progress[0]?.noProgress).toBe(1);
    expect(
      recovered.records.filter(
        (record) =>
          record.kind === 'coreEvent' &&
          record.data.type === 'progress_assessed' &&
          record.data.reasonCode === 'action',
      ),
    ).toHaveLength(1);
    expect(readEffects(root)).toHaveLength(1);
  },
  20_000,
);

test.each(['modelReserved', 'modelResponse'] as const)(
  'retains interrupted model budgets across repeated crashes at %s',
  async (boundary) => {
    const root = mkdtempSync(join(tmpdir(), 'umibe-crash-'));
    for (let attempt = 1; attempt <= 2; attempt++) {
      expect(
        await runCrashProcess({
          directory: root,
          operation: attempt === 1 ? 'start' : 'resume',
          boundary,
        }),
      ).toEqual({ kind: 'boundary', boundary });
      const saved = await snapshot(root);
      expect(saved.state.modelAttempts).toBe(attempt);
      expect(saved.state.pendingModels).toHaveLength(1);
      expect(saved.state.pendingModels[0]?.phase).toBe(
        boundary === 'modelReserved' ? 'reserved' : 'dispatched',
      );
    }
    for (let restart = 0; restart < 2; restart++)
      expect(
        await runCrashProcess({
          directory: root,
          operation: 'resume',
          boundary,
        }),
      ).toMatchObject({ kind: 'done', status: 'paused' });
    const recovered = await snapshot(root);
    expect(recovered.state.modelAttempts).toBe(2);
    expect(recovered.state.pendingModels).toEqual([]);
    const interrupted = recovered.records.filter(
      (record) =>
        record.kind === 'coreEvent' && record.data.type === 'model_interrupted',
    );
    expect(interrupted).toHaveLength(2);
    expect(interrupted).toMatchObject([
      { data: { details: { usage: null } } },
      { data: { details: { usage: null } } },
    ]);
    expect(readEffects(root)).toEqual([]);
  },
  30_000,
);

test('retains deep goal identities and sibling order across two killed hosts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'umibe-crash-'));
  expect(
    await runCrashProcess({
      directory: root,
      operation: 'start',
      nested: true,
      boundary: 'afterResult',
    }),
  ).toMatchObject({ kind: 'boundary' });
  const first = await snapshot(root);
  expect(first.state.decision.context.graph.goalPath).toHaveLength(3);
  expect(first.state.goals.created).toBe(4);
  expect(
    await runCrashProcess({
      directory: root,
      operation: 'resume',
      nested: true,
      boundary: 'afterResult',
    }),
  ).toMatchObject({ kind: 'boundary' });
  const second = await snapshot(root);
  expect(second.state.decision.context.graph.goalPath).toHaveLength(3);
  expect(second.state.decision.context.graph.currentGoalRef).not.toEqual(
    first.state.decision.context.graph.currentGoalRef,
  );
  expect(
    second.state.decision.context.graph.goals.find(
      (goal) =>
        goal.id === first.state.decision.context.graph.currentGoalRef.id,
    )?.lifecycle,
  ).toBe('succeeded');
  expect(
    await runCrashProcess({
      directory: root,
      operation: 'resume',
      nested: true,
    }),
  ).toMatchObject({ kind: 'done', status: 'succeeded' });
  const final = await snapshot(root);
  expect(
    final.state.decision.context.graph.goals.map(
      ({ id, version, parentGoalRef }) => ({ id, version, parentGoalRef }),
    ),
  ).toEqual(
    first.state.decision.context.graph.goals.map(
      ({ id, version, parentGoalRef }) => ({ id, version, parentGoalRef }),
    ),
  );
  expect(final.state.goals.created).toBe(4);
  expect(final.state.actionAttempts).toBe(3);
  expect(final.state.modelAttempts).toBe(1);
  expect(readEffects(root)).toMatchObject([
    { depth: 3, goal: 'First sample' },
    { depth: 3, goal: 'Second sample' },
    { depth: 2, goal: 'Third sample' },
  ]);
}, 30_000);

test.each(['pauseRun', 'cancelRun'] as const)(
  'preserves %s and deduplicates its event after a lost commit acknowledgement',
  async (control) => {
    const root = mkdtempSync(join(tmpdir(), 'umibe-crash-'));
    expect(
      await runCrashProcess({
        directory: root,
        operation: 'start',
        control,
        boundary: 'controlCommitted',
      }),
    ).toMatchObject({ kind: 'boundary' });
    const saved = await snapshot(root);
    expect(saved.summary.status).toBe(
      control === 'pauseRun' ? 'pausing' : 'cancelling',
    );
    expect(saved.state.control.stopCause?.eventId).toBe('operator-control');
    const resumed = await runCrashProcess({
      directory: root,
      operation: 'resume',
      duplicate: control,
    });
    expect(resumed).toMatchObject({
      kind: control === 'pauseRun' ? 'done' : 'error',
      status: 'cancelled',
      duplicate: { conflict: 'event_conflict' },
    });
    expect(resumed.duplicate?.after).toBe(resumed.duplicate?.before);
    const recovered = await snapshot(root);
    expect(
      recovered.records.filter(
        (record) => record.eventId === 'operator-control',
      ),
    ).toHaveLength(1);
    expect(readEffects(root)).toEqual([]);
  },
  20_000,
);

test('reconciles a cancelled crashed execution without reopening the task', async () => {
  const root = mkdtempSync(join(tmpdir(), 'umibe-crash-'));
  expect(
    await runCrashProcess({
      directory: root,
      operation: 'start',
      cancelAfterEffect: true,
      boundary: 'controlCommitted',
    }),
  ).toMatchObject({ kind: 'boundary' });
  const saved = await snapshot(root);
  expect(saved.summary.status).toBe('cancelling');
  expect(saved.state.execution?.result).toBeNull();
  expect(readEffects(root)).toHaveLength(1);
  expect(
    await runCrashProcess({ directory: root, operation: 'resume' }),
  ).toMatchObject({
    kind: 'error',
    reason: 'resume_unavailable',
    status: 'cancelled',
  });
  const stopped = await snapshot(root);
  expect(stopped.state.execution?.phase).toBe('unknown');
  expect(
    await runCrashProcess({ directory: root, operation: 'reconcile' }),
  ).toMatchObject({ kind: 'done', status: 'cancelled' });
  const cleaned = await snapshot(root);
  expect(cleaned.state.execution?.result).toMatchObject({
    outcome: 'succeeded',
    underlyingSettled: true,
  });
  expect(cleaned.state.actionAttempts).toBe(1);
  expect(cleaned.state.control.stopCause).toEqual(
    stopped.state.control.stopCause,
  );
  expect(
    cleaned.state.decision.context.graph.goals.every(
      (goal) => goal.lifecycle === 'cancelled',
    ),
  ).toBe(true);
  expect(readEffects(root)).toHaveLength(1);
}, 20_000);
