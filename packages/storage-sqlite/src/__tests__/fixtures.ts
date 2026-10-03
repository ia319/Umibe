import type { RunCommit, RunLease, RunRecordDraft } from '@umibe/core';

export function commit(
  lease: RunLease,
  revision: number | null,
  records: readonly RunRecordDraft[] = [],
): RunCommit {
  return {
    ownerToken: lease.token,
    runId: lease.runId,
    expectedRevision: revision,
    status: 'running',
    rootGoalRef: { id: 'root', version: 1 },
    currentGoalRef: { id: 'root', version: 1 },
    stateSchemaVersion: 1,
    state: { phase: 'running' },
    records,
  };
}

export function intent(runId: string): RunRecordDraft {
  return {
    formatVersion: 1,
    eventId: 'intent',
    runId,
    kind: 'actionIntent',
    data: {
      executionId: 'execution',
      decisionId: 'decision',
      candidateSetId: 'set',
      candidateId: 'candidate',
      actionId: 'move',
      actionVersion: 1,
      params: {},
      rootGoalRef: { id: 'root', version: 1 },
      currentGoalRef: { id: 'root', version: 1 },
      goalPathRef: 'path',
      planRef: { id: 'plan', version: 1, rootGoalVersion: 1 },
      observationRef: { id: 'observation', revision: 1 },
      constraintsVersion: 1,
    },
  };
}

export function result(runId: string): RunRecordDraft {
  return {
    formatVersion: 1,
    eventId: 'result',
    runId,
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
  };
}
