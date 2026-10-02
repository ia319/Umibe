import type {
  ActionIntent,
  ActionResult,
  CoreEventData,
  RunCheckpoint,
  RunRecord,
  RunStatus,
  RunSummary,
} from '#internal/contracts/record';
import type { JsonValue } from '#internal/contracts/json';
import { ContractError } from '#internal/errors';
import { readGoalAssessment } from './assessment.js';
import {
  requireInteger,
  requireKeys,
  requireObject,
  requireString,
  requireTimestamp,
} from './fields.js';
import type { FieldContext } from './fields.js';
import { parseApplicationEvent } from './event.js';
import { parseJsonValue } from './json.js';
import { readGoalRef, readObservationRef, readPlanRef } from './references.js';

const recordContext: FieldContext = {
  code: 'INVALID_RUN_RECORD',
  stage: 'run_record',
};
const summaryContext: FieldContext = {
  code: 'INVALID_RUN_SUMMARY',
  stage: 'run_summary',
};
const checkpointContext: FieldContext = {
  code: 'INVALID_RUN_CHECKPOINT',
  stage: 'run_checkpoint',
};

function readFormatVersion(
  value: JsonValue | undefined,
  context: FieldContext,
): 1 {
  if (value !== 1) {
    throw new ContractError(
      context.code,
      context.stage,
      '/formatVersion',
      'unsupported_format_version',
    );
  }
  return 1;
}

function readRunStatus(
  value: JsonValue | undefined,
  context: FieldContext,
  path: string,
): RunStatus {
  if (
    value !== 'created' &&
    value !== 'running' &&
    value !== 'pausing' &&
    value !== 'paused' &&
    value !== 'cancelling' &&
    value !== 'cancelled' &&
    value !== 'succeeded' &&
    value !== 'failed'
  ) {
    throw new ContractError(
      context.code,
      context.stage,
      path,
      'invalid_run_status',
    );
  }
  return value;
}

function readNullableString(
  value: JsonValue | undefined,
  context: FieldContext,
  path: string,
): string | null {
  return value === null ? null : requireString(value, context, path);
}

function readCoreEvent(value: JsonValue | undefined): CoreEventData {
  const path = '/data';
  const object = requireObject(value, recordContext, path);
  requireKeys(
    object,
    [
      'source',
      'type',
      'reasonCode',
      'goalRef',
      'decisionId',
      'requestId',
      'executionId',
      'details',
    ],
    recordContext,
    path,
  );
  if (object.source !== 'core') {
    throw new ContractError(
      recordContext.code,
      recordContext.stage,
      `${path}/source`,
      'invalid_core_source',
    );
  }
  return Object.freeze({
    source: 'core',
    type: requireString(object.type, recordContext, `${path}/type`),
    reasonCode: requireString(
      object.reasonCode,
      recordContext,
      `${path}/reasonCode`,
    ),
    goalRef:
      object.goalRef === null
        ? null
        : readGoalRef(object.goalRef, recordContext, `${path}/goalRef`),
    decisionId: readNullableString(
      object.decisionId,
      recordContext,
      `${path}/decisionId`,
    ),
    requestId: readNullableString(
      object.requestId,
      recordContext,
      `${path}/requestId`,
    ),
    executionId: readNullableString(
      object.executionId,
      recordContext,
      `${path}/executionId`,
    ),
    details: requireObject(object.details, recordContext, `${path}/details`),
  });
}

function readActionIntent(value: JsonValue | undefined): ActionIntent {
  const path = '/data';
  const object = requireObject(value, recordContext, path);
  requireKeys(
    object,
    [
      'executionId',
      'decisionId',
      'candidateSetId',
      'candidateId',
      'actionId',
      'actionVersion',
      'params',
      'rootGoalRef',
      'currentGoalRef',
      'goalPathRef',
      'planRef',
      'observationRef',
      'constraintsVersion',
    ],
    recordContext,
    path,
  );
  const rootGoalRef = readGoalRef(
    object.rootGoalRef,
    recordContext,
    `${path}/rootGoalRef`,
  );
  const planRef = readPlanRef(object.planRef, recordContext, `${path}/planRef`);
  if (planRef.rootGoalVersion !== rootGoalRef.version) {
    throw new ContractError(
      recordContext.code,
      recordContext.stage,
      `${path}/planRef/rootGoalVersion`,
      'stale_root_version',
    );
  }
  return Object.freeze({
    executionId: requireString(
      object.executionId,
      recordContext,
      `${path}/executionId`,
    ),
    decisionId: requireString(
      object.decisionId,
      recordContext,
      `${path}/decisionId`,
    ),
    candidateSetId: requireString(
      object.candidateSetId,
      recordContext,
      `${path}/candidateSetId`,
    ),
    candidateId: requireString(
      object.candidateId,
      recordContext,
      `${path}/candidateId`,
    ),
    actionId: requireString(object.actionId, recordContext, `${path}/actionId`),
    actionVersion: requireInteger(
      object.actionVersion,
      1,
      recordContext,
      `${path}/actionVersion`,
    ),
    params: requireObject(object.params, recordContext, `${path}/params`),
    rootGoalRef,
    currentGoalRef: readGoalRef(
      object.currentGoalRef,
      recordContext,
      `${path}/currentGoalRef`,
    ),
    goalPathRef: requireString(
      object.goalPathRef,
      recordContext,
      `${path}/goalPathRef`,
    ),
    planRef,
    observationRef: readObservationRef(
      object.observationRef,
      recordContext,
      `${path}/observationRef`,
    ),
    constraintsVersion: requireInteger(
      object.constraintsVersion,
      1,
      recordContext,
      `${path}/constraintsVersion`,
    ),
  });
}

export function readActionResult(
  value: JsonValue | undefined,
  context: FieldContext,
  path: string,
): ActionResult {
  const object = requireObject(value, context, path);
  requireKeys(
    object,
    [
      'executionId',
      'outcome',
      'reasonCode',
      'underlyingSettled',
      'confirmedEffects',
      'unresolvedEffects',
      'progress',
      'stopCauseEventId',
    ],
    context,
    path,
  );
  const outcome = object.outcome;
  if (
    outcome !== 'succeeded' &&
    outcome !== 'failed' &&
    outcome !== 'cancelled' &&
    outcome !== 'unknown'
  ) {
    throw new ContractError(
      context.code,
      context.stage,
      `${path}/outcome`,
      'invalid_action_outcome',
    );
  }
  if (typeof object.underlyingSettled !== 'boolean') {
    throw new ContractError(
      context.code,
      context.stage,
      `${path}/underlyingSettled`,
      'expected_boolean',
    );
  }
  const unresolvedEffects = requireObject(
    object.unresolvedEffects,
    context,
    `${path}/unresolvedEffects`,
  );
  const hasUnresolved = Object.keys(unresolvedEffects).length > 0;
  if (
    (outcome !== 'unknown' && (!object.underlyingSettled || hasUnresolved)) ||
    (outcome === 'unknown' && object.underlyingSettled && !hasUnresolved)
  ) {
    throw new ContractError(
      context.code,
      context.stage,
      `${path}/outcome`,
      'inconsistent_action_result',
    );
  }
  return Object.freeze({
    executionId: requireString(
      object.executionId,
      context,
      `${path}/executionId`,
    ),
    outcome,
    reasonCode: requireString(object.reasonCode, context, `${path}/reasonCode`),
    underlyingSettled: object.underlyingSettled,
    confirmedEffects: requireObject(
      object.confirmedEffects,
      context,
      `${path}/confirmedEffects`,
    ),
    unresolvedEffects,
    progress: requireObject(object.progress, context, `${path}/progress`),
    stopCauseEventId: readNullableString(
      object.stopCauseEventId,
      context,
      `${path}/stopCauseEventId`,
    ),
  });
}

/** Validate a persisted event envelope and its typed payload.
 * @param input - Untrusted event data read from storage or import.
 * @returns A detached, frozen version-1 event record.
 * @throws ContractError for incompatible format, invalid payload or illegal result combinations.
 */
export function parseRunRecord(input: unknown): RunRecord {
  const object = requireObject(
    parseJsonValue(input, recordContext.stage),
    recordContext,
    '',
  );
  requireKeys(
    object,
    [
      'formatVersion',
      'eventId',
      'runId',
      'sequence',
      'committedAt',
      'kind',
      'data',
    ],
    recordContext,
    '',
  );
  const base = {
    formatVersion: readFormatVersion(object.formatVersion, recordContext),
    eventId: requireString(object.eventId, recordContext, '/eventId'),
    runId: requireString(object.runId, recordContext, '/runId'),
    sequence: requireInteger(object.sequence, 1, recordContext, '/sequence'),
    committedAt: requireTimestamp(
      object.committedAt,
      recordContext,
      '/committedAt',
    ),
  };
  switch (object.kind) {
    case 'applicationEvent': {
      let data;
      try {
        data = parseApplicationEvent(object.data);
      } catch (error) {
        if (error instanceof ContractError) {
          throw new ContractError(
            recordContext.code,
            recordContext.stage,
            `/data${error.path}`,
            error.reason,
          );
        }
        throw error;
      }
      if (data.eventId !== base.eventId || data.runId !== base.runId) {
        throw new ContractError(
          recordContext.code,
          recordContext.stage,
          '/data',
          'event_identity_mismatch',
        );
      }
      return Object.freeze({ ...base, kind: 'applicationEvent', data });
    }
    case 'coreEvent':
      return Object.freeze({
        ...base,
        kind: 'coreEvent',
        data: readCoreEvent(object.data),
      });
    case 'actionIntent':
      return Object.freeze({
        ...base,
        kind: 'actionIntent',
        data: readActionIntent(object.data),
      });
    case 'actionResult':
      return Object.freeze({
        ...base,
        kind: 'actionResult',
        data: readActionResult(object.data, recordContext, '/data'),
      });
    case 'goalAssessment':
      return Object.freeze({
        ...base,
        kind: 'goalAssessment',
        data: readGoalAssessment(object.data, recordContext, '/data'),
      });
    default:
      throw new ContractError(
        recordContext.code,
        recordContext.stage,
        '/kind',
        'invalid_record_kind',
      );
  }
}

/** Validate a run list entry without inferring liveness from its status.
 * @param input - Untrusted summary data.
 * @returns A detached, frozen version-1 summary.
 * @throws ContractError for malformed or incompatible data.
 */
export function parseRunSummary(input: unknown): RunSummary {
  const object = requireObject(
    parseJsonValue(input, summaryContext.stage),
    summaryContext,
    '',
  );
  requireKeys(
    object,
    [
      'formatVersion',
      'runId',
      'status',
      'rootGoalRef',
      'currentGoalRef',
      'lastSequence',
      'lastActivityAt',
      'checkpointRevision',
    ],
    summaryContext,
    '',
  );
  return Object.freeze({
    formatVersion: readFormatVersion(object.formatVersion, summaryContext),
    runId: requireString(object.runId, summaryContext, '/runId'),
    status: readRunStatus(object.status, summaryContext, '/status'),
    rootGoalRef: readGoalRef(
      object.rootGoalRef,
      summaryContext,
      '/rootGoalRef',
    ),
    currentGoalRef:
      object.currentGoalRef === null
        ? null
        : readGoalRef(object.currentGoalRef, summaryContext, '/currentGoalRef'),
    lastSequence: requireInteger(
      object.lastSequence,
      0,
      summaryContext,
      '/lastSequence',
    ),
    lastActivityAt: requireTimestamp(
      object.lastActivityAt,
      summaryContext,
      '/lastActivityAt',
    ),
    checkpointRevision: requireInteger(
      object.checkpointRevision,
      0,
      summaryContext,
      '/checkpointRevision',
    ),
  });
}

/** Validate a checkpoint envelope; P3 defines and validates continuation state.
 * @param input - Untrusted checkpoint data.
 * @returns A detached, frozen version-1 checkpoint envelope.
 * @throws ContractError for malformed or incompatible envelope fields.
 */
export function parseRunCheckpoint(input: unknown): RunCheckpoint {
  const object = requireObject(
    parseJsonValue(input, checkpointContext.stage),
    checkpointContext,
    '',
  );
  requireKeys(
    object,
    [
      'formatVersion',
      'runId',
      'revision',
      'committedSequence',
      'status',
      'stateSchemaVersion',
      'state',
    ],
    checkpointContext,
    '',
  );
  return Object.freeze({
    formatVersion: readFormatVersion(object.formatVersion, checkpointContext),
    runId: requireString(object.runId, checkpointContext, '/runId'),
    revision: requireInteger(
      object.revision,
      0,
      checkpointContext,
      '/revision',
    ),
    committedSequence: requireInteger(
      object.committedSequence,
      0,
      checkpointContext,
      '/committedSequence',
    ),
    status: readRunStatus(object.status, checkpointContext, '/status'),
    stateSchemaVersion: requireInteger(
      object.stateSchemaVersion,
      1,
      checkpointContext,
      '/stateSchemaVersion',
    ),
    state: requireObject(object.state, checkpointContext, '/state'),
  });
}
