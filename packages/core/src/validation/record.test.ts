import { expect, test } from 'vitest';
import {
  parseRunCheckpoint,
  parseRunRecord,
  parseRunSummary,
} from './record.js';

function record<T>(kind: string, data: T) {
  return {
    formatVersion: 1,
    eventId: 'event-1',
    runId: 'run-1',
    sequence: 1,
    committedAt: '2026-09-28T12:01:00.000Z',
    kind,
    data,
  };
}

function actionIntent() {
  return {
    executionId: 'execution-1',
    decisionId: 'decision-1',
    candidateSetId: 'set-1',
    candidateId: 'candidate-1',
    actionId: 'move',
    actionVersion: 1,
    params: { mode: 'sprint' },
    rootGoalRef: { id: 'root', version: 2 },
    currentGoalRef: { id: 'child', version: 1 },
    goalPathRef: 'path-1',
    planRef: { id: 'plan', version: 1, rootGoalVersion: 2 },
    observationRef: { id: 'observation', revision: 3 },
    constraintsVersion: 2,
  };
}

test('records a fixed action intent and keeps unknown external effects distinct', () => {
  const input = record('actionIntent', actionIntent());
  const intent = parseRunRecord(input);
  input.data.params.mode = 'walk';
  expect(intent.kind).toBe('actionIntent');
  if (intent.kind === 'actionIntent') {
    expect(intent.data.params.mode).toBe('sprint');
  }

  const result = parseRunRecord(
    record('actionResult', {
      executionId: 'execution-1',
      outcome: 'unknown',
      reasonCode: 'stop_unconfirmed',
      underlyingSettled: false,
      confirmedEffects: { distance: 3 },
      unresolvedEffects: {},
      progress: { distance: 3 },
      stopCauseEventId: 'event-stop',
    }),
  );
  expect(result.kind).toBe('actionResult');
  if (result.kind === 'actionResult') {
    expect(result.data.underlyingSettled).toBe(false);
    expect(result.data.confirmedEffects.distance).toBe(3);
  }
});

test('rejects incompatible records and contradictory action outcomes', () => {
  const inconsistent = record('actionResult', {
    executionId: 'execution-1',
    outcome: 'succeeded',
    reasonCode: 'completed',
    underlyingSettled: false,
    confirmedEffects: {},
    unresolvedEffects: {},
    progress: {},
    stopCauseEventId: null,
  });
  expect(() => parseRunRecord(inconsistent)).toThrowError(
    expect.objectContaining({
      code: 'INVALID_RUN_RECORD',
      path: '/data/outcome',
      reason: 'inconsistent_action_result',
    }),
  );
  expect(() =>
    parseRunRecord({
      ...record('actionIntent', actionIntent()),
      formatVersion: 2,
    }),
  ).toThrowError(
    expect.objectContaining({
      path: '/formatVersion',
      reason: 'unsupported_format_version',
    }),
  );
  const invalidAssessment = record('goalAssessment', {
    goalRef: { id: 'child', version: 1 },
    observationRef: { id: 'observation', revision: 3 },
    outcome: 'passed',
    evidence: null,
    reason: null,
  });
  expect(() => parseRunRecord(invalidAssessment)).toThrowError(
    expect.objectContaining({
      path: '/data/outcome',
      reason: 'invalid_assessment',
    }),
  );
});

test('validates run summary and versioned checkpoint envelope without interpreting continuation', () => {
  const summary = parseRunSummary({
    formatVersion: 1,
    runId: 'run-1',
    status: 'paused',
    rootGoalRef: { id: 'root', version: 2 },
    currentGoalRef: { id: 'child', version: 1 },
    lastSequence: 3,
    lastActivityAt: '2026-09-28T12:01:00.000Z',
    checkpointRevision: 2,
  });
  expect(summary.status).toBe('paused');
  const checkpointInput = {
    formatVersion: 1,
    runId: 'run-1',
    revision: 2,
    committedSequence: 3,
    status: 'paused',
    stateSchemaVersion: 1,
    state: { budget: { requests: 3 } },
  };
  const checkpoint = parseRunCheckpoint(checkpointInput);
  checkpointInput.state.budget.requests = 4;
  expect(checkpoint.state.budget).toEqual({ requests: 3 });
  expect(Object.isFrozen(checkpoint.state.budget)).toBe(true);
});
