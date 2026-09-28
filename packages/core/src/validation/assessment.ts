import type { GoalAssessment } from '#internal/contracts/goal';
import type { JsonValue } from '#internal/contracts/json';
import { ContractError } from '#internal/errors';
import { requireKeys, requireObject, requireString } from './fields.js';
import type { FieldContext } from './fields.js';
import { readGoalRef, readObservationRef } from './references.js';

export function readGoalAssessment(
  value: JsonValue | undefined,
  context: FieldContext,
  path: string,
): GoalAssessment {
  const object = requireObject(value, context, path);
  requireKeys(
    object,
    ['goalRef', 'observationRef', 'outcome', 'evidence', 'reason'],
    context,
    path,
  );
  const goalRef = readGoalRef(object.goalRef, context, `${path}/goalRef`);
  const observationRef = readObservationRef(
    object.observationRef,
    context,
    `${path}/observationRef`,
  );
  const evidence = object.evidence;
  if (evidence === undefined) {
    throw new ContractError(
      context.code,
      context.stage,
      `${path}/evidence`,
      'missing_field',
    );
  }
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
    });
  }
  if (object.outcome === 'notYet' || object.outcome === 'needsInput') {
    return Object.freeze({
      goalRef,
      observationRef,
      outcome: object.outcome,
      evidence,
      reason: requireString(object.reason, context, `${path}/reason`),
    });
  }
  throw new ContractError(
    context.code,
    context.stage,
    `${path}/outcome`,
    'invalid_assessment',
  );
}
