import { expect, test } from 'vitest';
import type { GoalAssessment } from '#internal/contracts/goal';
import { createRunControl, transitionRun } from './state.js';

const root = { id: 'root', version: 1 };
const observationRef = { id: 'observation', revision: 2 };
const cause = { eventId: 'pause', reasonCode: 'needs_input' };
const passed: GoalAssessment = {
  goalRef: root,
  observationRef,
  outcome: 'passed',
  reason: null,
  evidence: {
    source: 'application',
    observationPaths: ['/ready'],
    executionIds: [],
    details: {},
  },
};

test('pauses in two stages and resumes without carrying the old stop cause', () => {
  const created = createRunControl(root);
  const running = transitionRun(created, { kind: 'start' });
  const pausing = transitionRun(running, { kind: 'pause', cause });
  expect(pausing.status).toBe('pausing');
  expect(running.status).toBe('running');
  expect(transitionRun(pausing, { kind: 'pause', cause })).toBe(pausing);
  const paused = transitionRun(pausing, {
    kind: 'stopSettled',
    blocker: cause,
  });
  expect(paused).toMatchObject({
    status: 'paused',
    stopCause: cause,
    blocker: cause,
  });
  const resumed = transitionRun(paused, { kind: 'resume' });
  expect(resumed).toMatchObject({
    status: 'running',
    stopCause: null,
    blocker: null,
  });
  const nextPause = transitionRun(resumed, { kind: 'pause', cause });
  expect(
    transitionRun(nextPause, { kind: 'stopSettled', blocker: null }).blocker,
  ).toBeNull();
  expect(() => transitionRun(running, { kind: 'resume' })).toThrowError(
    expect.objectContaining({ reason: 'invalid_transition' }),
  );
});

test('cancellation takes priority while preserving the first stop cause and uncertain effects', () => {
  const pausing = transitionRun(createRunControl(root), {
    kind: 'pause',
    cause,
  });
  const cancel = {
    kind: 'cancel',
    cause: { eventId: 'cancel', reasonCode: 'user_cancelled' },
  } as const;
  const cancelling = transitionRun(pausing, cancel);
  expect(transitionRun(cancelling, { kind: 'pause', cause })).toBe(cancelling);
  expect(transitionRun(cancelling, cancel)).toBe(cancelling);
  const blocker = { eventId: 'timeout', reasonCode: 'execution_unsettled' };
  const failedCleanup = transitionRun(cancelling, {
    kind: 'fail',
    cause: blocker,
  });
  expect(failedCleanup.status).toBe('cancelling');
  const cancelled = transitionRun(failedCleanup, {
    kind: 'stopSettled',
    blocker: null,
  });
  expect(cancelled).toMatchObject({
    status: 'cancelled',
    stopCause: cause,
    blocker,
  });
  expect(transitionRun(cancelled, cancel)).toBe(cancelled);
  expect(() => transitionRun(cancelled, { kind: 'resume' })).toThrowError(
    expect.objectContaining({ reason: 'terminal_run' }),
  );
});

test('retains a paused blocker during cancellation unless settlement supplies a replacement', () => {
  const blocker = { eventId: 'timeout', reasonCode: 'execution_unsettled' };
  const pausing = transitionRun(createRunControl(root), {
    kind: 'pause',
    cause,
  });
  const paused = transitionRun(pausing, { kind: 'stopSettled', blocker });
  const cancelling = transitionRun(paused, {
    kind: 'cancel',
    cause: { eventId: 'cancel', reasonCode: 'user_cancelled' },
  });
  expect(
    transitionRun(cancelling, { kind: 'stopSettled', blocker: null }),
  ).toMatchObject({ status: 'cancelled', stopCause: cause, blocker });

  const replacement = { eventId: 'cleanup', reasonCode: 'effects_unknown' };
  expect(
    transitionRun(cancelling, {
      kind: 'stopSettled',
      blocker: replacement,
    }),
  ).toMatchObject({
    status: 'cancelled',
    stopCause: cause,
    blocker: replacement,
  });
});

test('only a passed assessment of the current root and observation can finish a running task', () => {
  const running = transitionRun(createRunControl(root), { kind: 'start' });
  for (const assessment of [
    { ...passed, goalRef: { id: 'child', version: 1 } },
    { ...passed, goalRef: { ...root, version: 2 } },
    { ...passed, observationRef: { ...observationRef, revision: 1 } },
    { ...passed, outcome: 'notYet', reason: 'missing_result' } as const,
  ]) {
    expect(() =>
      transitionRun(running, { kind: 'succeed', assessment, observationRef }),
    ).toThrowError(expect.objectContaining({ reason: 'unverified_root' }));
  }
  const succeeded = transitionRun(running, {
    kind: 'succeed',
    assessment: passed,
    observationRef,
  });
  expect(succeeded.status).toBe('succeeded');
  expect(() => transitionRun(succeeded, { kind: 'start' })).toThrowError(
    expect.objectContaining({ reason: 'terminal_run' }),
  );
  const pausing = transitionRun(running, { kind: 'pause', cause });
  expect(() =>
    transitionRun(pausing, {
      kind: 'succeed',
      assessment: passed,
      observationRef,
    }),
  ).toThrowError(expect.objectContaining({ reason: 'invalid_transition' }));
});

test('failed runs stay terminal and input objects cannot alter accepted control state', () => {
  const input = { ...root };
  const state = createRunControl(input);
  input.version = 2;
  expect(state.rootGoalRef.version).toBe(1);
  const mutableCause = { ...cause };
  const failed = transitionRun(state, { kind: 'fail', cause: mutableCause });
  mutableCause.reasonCode = 'changed';
  expect(failed.stopCause).toEqual(cause);
  expect(() => transitionRun(failed, { kind: 'resume' })).toThrowError();
  expect(() =>
    transitionRun(state, { kind: 'stopSettled', blocker: null }),
  ).toThrowError();
});
