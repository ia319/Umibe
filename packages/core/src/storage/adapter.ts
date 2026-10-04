import type { RunRecord } from '../contracts/record.js';
import { ContractError } from '../errors.js';
import {
  requireInteger,
  requireKeys,
  requireObject,
  requireString,
} from '../validation/fields.js';
import { isJsonArray, parseJsonValue } from '../validation/json.js';
import {
  parseRunCheckpoint,
  parseRunRecord,
  parseRunSummary,
} from '../validation/record.js';
import type { CommitResult, RunCommit, RunRecordDraft } from './contracts.js';

const context = {
  code: 'INVALID_STORE_COMMIT',
  stage: 'store_commit',
} as const;

function invalid(path: string, reason: string): never {
  throw new ContractError(context.code, context.stage, path, reason);
}

/** Capture and validate a caller's batch synchronously, before crossing an async boundary. */
export function captureRunCommit(input: unknown): RunCommit {
  const value = requireObject(
    parseJsonValue(input, context.stage),
    context,
    '',
  );
  requireKeys(
    value,
    [
      'ownerToken',
      'runId',
      'expectedRevision',
      'status',
      'rootGoalRef',
      'currentGoalRef',
      'stateSchemaVersion',
      'state',
      'records',
    ],
    context,
    '',
  );
  const ownerToken = requireString(value.ownerToken, context, '/ownerToken');
  const runId = requireString(value.runId, context, '/runId');
  const expectedRevision =
    value.expectedRevision === null
      ? null
      : requireInteger(value.expectedRevision, 1, context, '/expectedRevision');
  const entries = value.records;
  if (!isJsonArray(entries)) invalid('/records', 'expected_array');
  const records: RunRecordDraft[] = entries.map((entry, index) => {
    const path = `/records/${index}`;
    const draft = requireObject(entry, context, path);
    requireKeys(
      draft,
      ['formatVersion', 'eventId', 'runId', 'kind', 'data'],
      context,
      path,
    );
    if (draft.runId !== runId) invalid(`${path}/runId`, 'cross_run_record');
    try {
      const record = parseRunRecord({
        ...draft,
        sequence: index + 1,
        committedAt: '2000-01-01T00:00:00.000Z',
      });
      return Object.freeze({
        formatVersion: record.formatVersion,
        eventId: record.eventId,
        runId: record.runId,
        kind: record.kind,
        data: record.data,
      }) as RunRecordDraft;
    } catch (error) {
      if (error instanceof ContractError)
        invalid(`${path}${error.path}`, error.reason);
      throw error;
    }
  });
  try {
    const summary = parseRunSummary({
      formatVersion: 1,
      runId,
      status: value.status,
      rootGoalRef: value.rootGoalRef,
      currentGoalRef: value.currentGoalRef,
      lastSequence: 0,
      lastActivityAt: '2000-01-01T00:00:00.000Z',
      checkpointRevision: 1,
    });
    const checkpoint = parseRunCheckpoint({
      formatVersion: 1,
      runId,
      revision: 1,
      committedSequence: 0,
      status: summary.status,
      stateSchemaVersion: value.stateSchemaVersion,
      state: value.state,
    });
    return Object.freeze({
      ownerToken,
      runId,
      expectedRevision,
      status: summary.status,
      rootGoalRef: summary.rootGoalRef,
      currentGoalRef: summary.currentGoalRef,
      stateSchemaVersion: checkpoint.stateSchemaVersion,
      state: checkpoint.state,
      records: Object.freeze(records),
    });
  } catch (error) {
    if (error instanceof ContractError) invalid(error.path, error.reason);
    throw error;
  }
}

/** Committed history lookups must use the same isolated view as the eventual write. */
export interface CommitHistory {
  readonly revision: number | null;
  readonly lastSequence: number;
  hasEvent(eventId: string): boolean;
  hasIntent(executionId: string): boolean;
}

/** Validate history references before comparing revisions. Requires a captured batch; never mutates storage. */
export function prepareRunCommit(
  input: RunCommit,
  history: CommitHistory,
): CommitResult {
  const events = new Set<string>();
  const intents = new Set<string>();
  const committedAt = new Date().toISOString();
  const records: RunRecord[] = input.records.map((draft, index) => {
    const path = `/records/${index}`;
    if (events.has(draft.eventId) || history.hasEvent(draft.eventId))
      invalid(`${path}/eventId`, 'duplicate_event_id');
    if (draft.kind === 'actionIntent') {
      if (
        intents.has(draft.data.executionId) ||
        history.hasIntent(draft.data.executionId)
      )
        invalid(`${path}/data/executionId`, 'duplicate_execution_id');
      intents.add(draft.data.executionId);
    }
    if (
      draft.kind === 'actionResult' &&
      !intents.has(draft.data.executionId) &&
      !history.hasIntent(draft.data.executionId)
    )
      invalid(`${path}/data/executionId`, 'missing_action_intent');
    events.add(draft.eventId);
    return parseRunRecord({
      ...draft,
      sequence: history.lastSequence + index + 1,
      committedAt,
    });
  });
  if (input.expectedRevision !== history.revision)
    return Object.freeze({
      outcome: 'conflict',
      actualRevision: history.revision,
    });
  const revision = (history.revision ?? 0) + 1;
  const summary = parseRunSummary({
    formatVersion: 1,
    runId: input.runId,
    status: input.status,
    rootGoalRef: input.rootGoalRef,
    currentGoalRef: input.currentGoalRef,
    lastSequence: history.lastSequence + records.length,
    lastActivityAt: committedAt,
    checkpointRevision: revision,
  });
  const checkpoint = parseRunCheckpoint({
    formatVersion: 1,
    runId: input.runId,
    revision,
    committedSequence: summary.lastSequence,
    status: summary.status,
    stateSchemaVersion: input.stateSchemaVersion,
    state: input.state,
  });
  return Object.freeze({
    outcome: 'committed',
    summary,
    checkpoint,
    records: Object.freeze(records),
  });
}
