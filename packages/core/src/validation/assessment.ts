import type { GoalAssessment, GoalEvidence } from '#internal/contracts/goal';
import type { JsonValue } from '#internal/contracts/json';
import { ContractError } from '#internal/errors';
import { requireKeys, requireObject, requireString } from './fields.js';
import type { FieldContext } from './fields.js';
import { readGoalRef, readObservationRef } from './references.js';
import { isJsonArray } from './json.js';

function readEvidence(
  value: JsonValue | undefined,
  context: FieldContext,
  path: string,
): GoalEvidence {
  const object = requireObject(value, context, path);
  requireKeys(
    object,
    ['source', 'observationPaths', 'executionIds', 'details'],
    context,
    path,
  );
  const source = object.source;
  if (source !== 'application' && source !== 'model' && source !== 'human') {
    throw new ContractError(
      context.code,
      context.stage,
      `${path}/source`,
      'invalid_evidence_source',
    );
  }
  const paths = object.observationPaths;
  const ids = object.executionIds;
  if (!isJsonArray(paths) || !isJsonArray(ids)) {
    throw new ContractError(
      context.code,
      context.stage,
      path,
      'invalid_evidence_references',
    );
  }
  const observationPaths = Object.freeze(
    paths.map((item, index) =>
      requireString(item, context, `${path}/observationPaths/${index}`),
    ),
  );
  const executionIds = Object.freeze(
    ids.map((item, index) =>
      requireString(item, context, `${path}/executionIds/${index}`),
    ),
  );
  if (observationPaths.length + executionIds.length === 0) {
    throw new ContractError(
      context.code,
      context.stage,
      path,
      'evidence_without_reference',
    );
  }
  return Object.freeze({
    source,
    observationPaths,
    executionIds,
    details: requireObject(object.details, context, `${path}/details`),
  });
}

export function readGoalAssessment(
  value: JsonValue | undefined,
  context: FieldContext,
  path: string,
): GoalAssessment {
  const object = requireObject(value, context, path);
  requireKeys(
    object,
    [
      'goalRef',
      'observationRef',
      'outcome',
      'evidence',
      'reason',
      ...(object.progress === undefined ? [] : ['progress']),
    ],
    context,
    path,
  );
  const goalRef = readGoalRef(object.goalRef, context, `${path}/goalRef`);
  const observationRef = readObservationRef(
    object.observationRef,
    context,
    `${path}/observationRef`,
  );
  if (object.evidence === undefined) {
    throw new ContractError(
      context.code,
      context.stage,
      `${path}/evidence`,
      'missing_field',
    );
  }
  const evidence =
    object.evidence === null
      ? null
      : readEvidence(object.evidence, context, `${path}/evidence`);
  if (
    object.progress !== undefined &&
    (typeof object.progress !== 'number' ||
      !Number.isFinite(object.progress) ||
      object.progress < 0 ||
      evidence === null)
  )
    throw new ContractError(
      context.code,
      context.stage,
      `${path}/progress`,
      'invalid_progress',
    );
  const progress =
    typeof object.progress === 'number' ? { progress: object.progress } : {};
  if (
    object.outcome === 'passed' &&
    evidence !== null &&
    object.reason === null
  ) {
    return Object.freeze({
      goalRef,
      observationRef,
      outcome: 'passed',
      evidence,
      reason: null,
      ...progress,
    });
  }
  if (object.outcome === 'notYet' || object.outcome === 'needsInput') {
    return Object.freeze({
      goalRef,
      observationRef,
      outcome: object.outcome,
      evidence,
      reason: requireString(object.reason, context, `${path}/reason`),
      ...progress,
    });
  }
  throw new ContractError(
    context.code,
    context.stage,
    `${path}/outcome`,
    'invalid_assessment',
  );
}
