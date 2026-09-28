import type {
  GoalRef,
  ObservationRef,
  PlanRef,
} from '#internal/contracts/references';
import type { JsonValue } from '#internal/contracts/json';
import type { FieldContext } from './fields.js';
import {
  requireInteger,
  requireKeys,
  requireObject,
  requireString,
} from './fields.js';

export function readGoalRef(
  value: JsonValue | undefined,
  context: FieldContext,
  path: string,
): GoalRef {
  const object = requireObject(value, context, path);
  requireKeys(object, ['id', 'version'], context, path);
  return Object.freeze({
    id: requireString(object.id, context, `${path}/id`),
    version: requireInteger(object.version, 1, context, `${path}/version`),
  });
}

export function readObservationRef(
  value: JsonValue | undefined,
  context: FieldContext,
  path: string,
): ObservationRef {
  const object = requireObject(value, context, path);
  requireKeys(object, ['id', 'revision'], context, path);
  return Object.freeze({
    id: requireString(object.id, context, `${path}/id`),
    revision: requireInteger(object.revision, 0, context, `${path}/revision`),
  });
}

export function readPlanRef(
  value: JsonValue | undefined,
  context: FieldContext,
  path: string,
): PlanRef {
  const object = requireObject(value, context, path);
  requireKeys(object, ['id', 'version', 'rootGoalVersion'], context, path);
  return Object.freeze({
    id: requireString(object.id, context, `${path}/id`),
    version: requireInteger(object.version, 1, context, `${path}/version`),
    rootGoalVersion: requireInteger(
      object.rootGoalVersion,
      1,
      context,
      `${path}/rootGoalVersion`,
    ),
  });
}
