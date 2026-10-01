import type { ApplicationEvent } from '#internal/contracts/event';
import { ContractError } from '#internal/errors';
import {
  requireKeys,
  requireObject,
  requireString,
  requireTimestamp,
} from './fields.js';
import type { FieldContext } from './fields.js';
import { isJsonArray, parseJsonValue } from './json.js';
import { readGoalRef, readObservationRef, readPlanRef } from './references.js';

const context: FieldContext = {
  code: 'INVALID_APPLICATION_EVENT',
  stage: 'application_event',
};

/** Check an application event before it can influence core scheduling.
 * @param input - Untrusted event from the application.
 * @returns A detached, frozen event with validated control fields.
 * @throws ContractError for malformed fields or illegal timing/control combinations.
 */
export function parseApplicationEvent(input: unknown): ApplicationEvent {
  const object = requireObject(
    parseJsonValue(input, context.stage),
    context,
    '',
  );
  requireKeys(
    object,
    [
      'kind',
      'eventId',
      'runId',
      'type',
      'source',
      'observedAt',
      'reasonCode',
      'impact',
      'timing',
      'control',
      'currentGoalRef',
      'planRef',
      'goalPathRef',
      'executionId',
      'observationRef',
      'affectedGoalRefs',
      'details',
    ],
    context,
    '',
  );
  if (object.kind !== 'application') {
    throw new ContractError(
      context.code,
      context.stage,
      '/kind',
      'invalid_event_kind',
    );
  }
  const sourceObject = requireObject(object.source, context, '/source');
  requireKeys(sourceObject, ['kind', 'id'], context, '/source');
  if (sourceObject.kind !== 'application') {
    throw new ContractError(
      context.code,
      context.stage,
      '/source/kind',
      'invalid_source',
    );
  }
  const impact = object.impact;
  const timing = object.timing;
  const control = object.control;
  if (
    impact !== 'observation' &&
    impact !== 'candidates' &&
    impact !== 'plan'
  ) {
    throw new ContractError(
      context.code,
      context.stage,
      '/impact',
      'invalid_impact',
    );
  }
  if (timing !== 'immediate' && timing !== 'actionBoundary') {
    throw new ContractError(
      context.code,
      context.stage,
      '/timing',
      'invalid_timing',
    );
  }
  if (
    control !== 'none' &&
    control !== 'interruptAction' &&
    control !== 'pauseRun' &&
    control !== 'cancelRun'
  ) {
    throw new ContractError(
      context.code,
      context.stage,
      '/control',
      'invalid_control',
    );
  }
  if (timing === 'actionBoundary' && control !== 'none') {
    throw new ContractError(
      context.code,
      context.stage,
      '/control',
      'control_requires_immediate',
    );
  }
  const refs = object.affectedGoalRefs;
  if (!isJsonArray(refs)) {
    throw new ContractError(
      context.code,
      context.stage,
      '/affectedGoalRefs',
      'expected_array',
    );
  }
  const affectedGoalRefs = Object.freeze(
    refs.map((ref, index) =>
      readGoalRef(ref, context, `/affectedGoalRefs/${index}`),
    ),
  );
  if (
    new Set(affectedGoalRefs.map((ref) => ref.id)).size !==
    affectedGoalRefs.length
  ) {
    throw new ContractError(
      context.code,
      context.stage,
      '/affectedGoalRefs',
      'duplicate_goal_ref',
    );
  }
  const currentGoalRef =
    object.currentGoalRef === null
      ? null
      : readGoalRef(object.currentGoalRef, context, '/currentGoalRef');
  const planRef =
    object.planRef === null
      ? null
      : readPlanRef(object.planRef, context, '/planRef');
  const observationRef =
    object.observationRef === null
      ? null
      : readObservationRef(object.observationRef, context, '/observationRef');
  const goalPathRef =
    object.goalPathRef === null
      ? null
      : requireString(object.goalPathRef, context, '/goalPathRef');
  if (goalPathRef !== null && currentGoalRef === null) {
    throw new ContractError(
      context.code,
      context.stage,
      '/goalPathRef',
      'path_without_current_goal',
    );
  }
  return Object.freeze({
    kind: 'application',
    eventId: requireString(object.eventId, context, '/eventId'),
    runId: requireString(object.runId, context, '/runId'),
    type: requireString(object.type, context, '/type'),
    source: Object.freeze({
      kind: 'application',
      id: requireString(sourceObject.id, context, '/source/id'),
    }),
    observedAt: requireTimestamp(object.observedAt, context, '/observedAt'),
    reasonCode: requireString(object.reasonCode, context, '/reasonCode'),
    impact,
    timing,
    control,
    currentGoalRef,
    planRef,
    goalPathRef,
    executionId:
      object.executionId === null
        ? null
        : requireString(object.executionId, context, '/executionId'),
    observationRef,
    affectedGoalRefs,
    details: requireObject(object.details, context, '/details'),
  });
}
