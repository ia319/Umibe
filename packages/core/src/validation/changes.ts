import type {
  ChangeBatch,
  ChangeFact,
  RecordedChange,
  RecordedChangeBatch,
} from '#internal/contracts/changes';
import type { JsonValue } from '#internal/contracts/json';
import { ContractError } from '#internal/errors';
import {
  requireInteger,
  requireKeys,
  requireObject,
  requireString,
  requireTimestamp,
} from './fields.js';
import type { FieldContext } from './fields.js';
import { isJsonArray, parseJsonValue } from './json.js';

const context: FieldContext = {
  code: 'INVALID_OBSERVATION',
  stage: 'change_batch',
};

function readChangeFact(input: JsonValue, path: string): ChangeFact {
  const fact = requireObject(input, context, path);
  const optional = ['sourceEventId', 'sourceSequence', 'executionId'];
  requireKeys(
    fact,
    [
      'sourceEvent',
      'occurredAt',
      'data',
      ...optional.filter((field) => Object.hasOwn(fact, field)),
    ],
    context,
    path,
  );
  return Object.freeze({
    sourceEvent: requireString(
      fact.sourceEvent,
      context,
      `${path}/sourceEvent`,
    ),
    occurredAt:
      fact.occurredAt === null
        ? null
        : requireTimestamp(fact.occurredAt, context, `${path}/occurredAt`),
    data: fact.data!,
    ...(fact.sourceEventId === undefined
      ? {}
      : {
          sourceEventId: requireString(
            fact.sourceEventId,
            context,
            `${path}/sourceEventId`,
          ),
        }),
    ...(fact.sourceSequence === undefined
      ? {}
      : {
          sourceSequence: requireInteger(
            fact.sourceSequence,
            0,
            context,
            `${path}/sourceSequence`,
          ),
        }),
    ...(fact.executionId === undefined
      ? {}
      : {
          executionId: requireString(
            fact.executionId,
            context,
            `${path}/executionId`,
          ),
        }),
  });
}

function readRecordedChange(input: JsonValue, path: string): RecordedChange {
  const object = requireObject(input, context, path);
  const { sequence, batchId, source, receivedAt, ...fact } = object;
  return Object.freeze({
    ...readChangeFact(fact, path),
    sequence: requireInteger(sequence, 1, context, `${path}/sequence`),
    batchId: requireString(batchId, context, `${path}/batchId`),
    source: requireString(source, context, `${path}/source`),
    receivedAt: requireTimestamp(receivedAt, context, `${path}/receivedAt`),
  });
}

/**
 * Capture all facts before asynchronous admission without interpreting event names.
 * Returns detached, deeply frozen JSON; malformed or empty batches throw ContractError.
 */
export function parseChangeBatch(input: unknown): ChangeBatch {
  const object = requireObject(
    parseJsonValue(input, context.stage),
    context,
    '',
  );
  requireKeys(object, ['id', 'source', 'changes'], context, '');
  const items = object.changes;
  if (!isJsonArray(items) || items.length === 0) {
    throw new ContractError(
      context.code,
      context.stage,
      '/changes',
      'expected_nonempty_array',
    );
  }
  return Object.freeze({
    id: requireString(object.id, context, '/id'),
    source: requireString(object.source, context, '/source'),
    changes: Object.freeze(
      items.map((item, index) => readChangeFact(item, `/changes/${index}`)),
    ),
  });
}

/** Validate one persisted fact, including the core's sequence and source attribution. */
export function parseRecordedChange(input: unknown): RecordedChange {
  return readRecordedChange(parseJsonValue(input, context.stage), '');
}

/** Validate stored batch attribution and contiguous, positive fact sequences. */
export function parseRecordedChangeBatch(input: unknown): RecordedChangeBatch {
  const object = requireObject(
    parseJsonValue(input, context.stage),
    context,
    '',
  );
  requireKeys(
    object,
    ['id', 'runId', 'source', 'receivedAt', 'changes'],
    context,
    '',
  );
  const id = requireString(object.id, context, '/id');
  const runId = requireString(object.runId, context, '/runId');
  const source = requireString(object.source, context, '/source');
  const receivedAt = requireTimestamp(
    object.receivedAt,
    context,
    '/receivedAt',
  );
  const items = object.changes;
  if (!isJsonArray(items) || items.length === 0)
    throw new ContractError(
      context.code,
      context.stage,
      '/changes',
      'expected_nonempty_array',
    );
  const changes = items.map((item, index) =>
    readRecordedChange(item, `/changes/${index}`),
  );
  for (const [index, change] of changes.entries())
    if (
      change.batchId !== id ||
      change.source !== source ||
      change.receivedAt !== receivedAt ||
      (index > 0 && change.sequence !== changes[index - 1]!.sequence + 1)
    )
      throw new ContractError(
        context.code,
        context.stage,
        `/changes/${index}`,
        'batch_attribution_mismatch',
      );
  return Object.freeze({
    id,
    runId,
    source,
    receivedAt,
    changes: Object.freeze(changes),
  });
}
