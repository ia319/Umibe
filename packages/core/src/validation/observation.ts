import type {
  Observation,
  ObservationCoverage,
  ObservationFact,
} from '#internal/contracts/observation';
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
import { isJsonArray, jsonPointerChild, parseJsonValue } from './json.js';

const context: FieldContext = {
  code: 'INVALID_OBSERVATION',
  stage: 'observation',
};

function readFact(value: JsonValue, path: string): ObservationFact {
  const object = requireObject(value, context, path);
  switch (object.status) {
    case 'known':
      requireKeys(object, ['status', 'value'], context, path);
      return Object.freeze({ status: 'known', value: object.value! });
    case 'absent':
      requireKeys(object, ['status'], context, path);
      return Object.freeze({ status: 'absent' });
    case 'unknown':
      requireKeys(object, ['status', 'reason'], context, path);
      return Object.freeze({
        status: 'unknown',
        reason: requireString(object.reason, context, `${path}/reason`),
      });
    case 'unobserved':
      requireKeys(object, ['status'], context, path);
      return Object.freeze({ status: 'unobserved' });
    case 'stale':
      requireKeys(
        object,
        ['status', 'lastKnown', 'lastObservedAt'],
        context,
        path,
      );
      return Object.freeze({
        status: 'stale',
        lastKnown: object.lastKnown!,
        lastObservedAt: requireTimestamp(
          object.lastObservedAt,
          context,
          `${path}/lastObservedAt`,
        ),
      });
    default:
      throw new ContractError(
        context.code,
        context.stage,
        `${path}/status`,
        'invalid_fact_status',
      );
  }
}

/** Validate a detached observation without interpreting its application facts.
 * @param input - Untrusted observation data from the application or storage.
 * @returns A detached, frozen observation with explicit knowledge states.
 * @throws ContractError if JSON, coverage, facts or timestamps are invalid.
 */
export function parseObservation(input: unknown): Observation {
  const object = requireObject(
    parseJsonValue(input, context.stage),
    context,
    '',
  );
  requireKeys(
    object,
    ['runId', 'id', 'revision', 'observedAt', 'source', 'coverage', 'data'],
    context,
    '',
  );
  const coveragePath = '/coverage';
  const coverageObject = requireObject(object.coverage, context, coveragePath);
  requireKeys(
    coverageObject,
    ['scope', 'completeness', 'uncheckedScopes'],
    context,
    coveragePath,
  );
  const completeness = coverageObject.completeness;
  if (completeness !== 'complete' && completeness !== 'partial') {
    throw new ContractError(
      context.code,
      context.stage,
      `${coveragePath}/completeness`,
      'invalid_completeness',
    );
  }
  const unchecked = coverageObject.uncheckedScopes;
  if (!isJsonArray(unchecked)) {
    throw new ContractError(
      context.code,
      context.stage,
      `${coveragePath}/uncheckedScopes`,
      'expected_array',
    );
  }
  const uncheckedScopes = Object.freeze(
    unchecked.map((scope, index) =>
      requireString(scope, context, `${coveragePath}/uncheckedScopes/${index}`),
    ),
  );
  const coverage: ObservationCoverage = Object.freeze({
    scope: requireString(
      coverageObject.scope,
      context,
      `${coveragePath}/scope`,
    ),
    completeness,
    uncheckedScopes,
  });
  const dataObject = requireObject(object.data, context, '/data');
  const data: Record<string, ObservationFact> = {};
  const observedAt = requireTimestamp(
    object.observedAt,
    context,
    '/observedAt',
  );
  let hasIncompleteFact = false;
  for (const [name, value] of Object.entries(dataObject)) {
    const fact = readFact(value, jsonPointerChild('/data', name));
    if (fact.status === 'stale' && fact.lastObservedAt > observedAt) {
      throw new ContractError(
        context.code,
        context.stage,
        `${jsonPointerChild('/data', name)}/lastObservedAt`,
        'future_last_observation',
      );
    }
    Object.defineProperty(data, name, {
      value: fact,
      enumerable: true,
    });
    hasIncompleteFact ||=
      fact.status === 'unknown' ||
      fact.status === 'unobserved' ||
      fact.status === 'stale';
  }
  if (
    completeness === 'complete' &&
    (hasIncompleteFact || uncheckedScopes.length > 0)
  ) {
    throw new ContractError(
      context.code,
      context.stage,
      coveragePath,
      'incomplete_coverage',
    );
  }
  if (
    completeness === 'partial' &&
    !hasIncompleteFact &&
    uncheckedScopes.length === 0
  ) {
    throw new ContractError(
      context.code,
      context.stage,
      coveragePath,
      'partial_without_gap',
    );
  }
  return Object.freeze({
    runId: requireString(object.runId, context, '/runId'),
    id: requireString(object.id, context, '/id'),
    revision: requireInteger(object.revision, 0, context, '/revision'),
    observedAt,
    source: requireString(object.source, context, '/source'),
    coverage,
    data: Object.freeze(data),
  });
}
