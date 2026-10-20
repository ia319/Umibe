import type { RuntimeContext } from '#internal/contracts/context';
import type { JsonValue } from '#internal/contracts/json';
import { ContractError } from '#internal/errors';
import {
  requireInteger,
  requireKeys,
  requireObject,
  requireString,
} from './fields.js';
import type { FieldContext } from './fields.js';
import { readActionIntent, readActionResult } from './record.js';
import { readGoalRef } from './references.js';
import { readGoalAssessment } from './assessment.js';
import { isJsonArray } from './json.js';
import { readChoiceHistory } from './choice-history.js';

export function readRuntimeContext(
  value: JsonValue,
  context: FieldContext,
  path: string,
): RuntimeContext {
  const raw = requireObject(value, context, path);
  requireKeys(
    raw,
    [
      'execution',
      'recentResults',
      'progress',
      'blocker',
      'completedSiblings',
      ...(Object.hasOwn(raw, 'recentChoices') ? ['recentChoices'] : []),
    ],
    context,
    path,
  );
  let execution: RuntimeContext['execution'] = null;
  if (raw.execution !== null) {
    const item = requireObject(raw.execution, context, `${path}/execution`);
    requireKeys(
      item,
      ['executionId', 'phase', 'intent', 'progress', 'stopCause'],
      context,
      `${path}/execution`,
    );
    const phase = item.phase;
    if (
      phase !== 'prepared' &&
      phase !== 'running' &&
      phase !== 'succeeded' &&
      phase !== 'failed' &&
      phase !== 'cancelled' &&
      phase !== 'unknown'
    )
      throw new ContractError(
        context.code,
        context.stage,
        `${path}/execution/phase`,
        'invalid_execution_phase',
      );
    const executionId = requireString(
      item.executionId,
      context,
      `${path}/execution/executionId`,
    );
    const intent = readActionIntent(item.intent);
    if (intent.executionId !== executionId)
      throw new ContractError(
        context.code,
        context.stage,
        `${path}/execution/intent`,
        'execution_identity_mismatch',
      );
    const stop =
      item.stopCause === null
        ? null
        : requireObject(item.stopCause, context, `${path}/execution/stopCause`);
    if (stop !== null)
      requireKeys(
        stop,
        ['eventId', 'reasonCode'],
        context,
        `${path}/execution/stopCause`,
      );
    execution = Object.freeze({
      executionId,
      phase,
      intent,
      progress: requireObject(
        item.progress,
        context,
        `${path}/execution/progress`,
      ),
      stopCause:
        stop === null
          ? null
          : Object.freeze({
              eventId: requireString(
                stop.eventId,
                context,
                `${path}/execution/stopCause/eventId`,
              ),
              reasonCode: requireString(
                stop.reasonCode,
                context,
                `${path}/execution/stopCause/reasonCode`,
              ),
            }),
    });
  }
  let blocker: RuntimeContext['blocker'] = null;
  if (raw.blocker !== null) {
    const item = requireObject(raw.blocker, context, `${path}/blocker`);
    requireKeys(item, ['eventId', 'reasonCode'], context, `${path}/blocker`);
    blocker = Object.freeze({
      eventId: requireString(item.eventId, context, `${path}/blocker/eventId`),
      reasonCode: requireString(
        item.reasonCode,
        context,
        `${path}/blocker/reasonCode`,
      ),
    });
  }
  if (
    !isJsonArray(raw.recentResults) ||
    raw.recentResults.length > 50 ||
    !isJsonArray(raw.progress) ||
    !isJsonArray(raw.completedSiblings)
  )
    throw new ContractError(
      context.code,
      context.stage,
      path,
      'invalid_runtime_context',
    );
  const recentResults = Object.freeze(
    raw.recentResults.map((item, index) =>
      readActionResult(item, context, `${path}/recentResults/${index}`),
    ),
  );
  const progress = Object.freeze(
    raw.progress.map((value, index) => {
      const location = `${path}/progress/${index}`;
      const item = requireObject(value, context, location);
      requireKeys(
        item,
        ['goalRef', 'noProgress', 'recoveryAttempts', 'highWater'],
        context,
        location,
      );
      const highWater = item.highWater;
      if (
        highWater !== null &&
        (typeof highWater !== 'number' || highWater < 0)
      )
        throw new ContractError(
          context.code,
          context.stage,
          `${location}/highWater`,
          'invalid_progress',
        );
      return Object.freeze({
        goalRef: readGoalRef(item.goalRef, context, `${location}/goalRef`),
        noProgress: requireInteger(
          item.noProgress,
          0,
          context,
          `${location}/noProgress`,
        ),
        recoveryAttempts: requireInteger(
          item.recoveryAttempts,
          0,
          context,
          `${location}/recoveryAttempts`,
        ),
        highWater,
      });
    }),
  );
  const completedSiblings = Object.freeze(
    raw.completedSiblings.map((value, index) => {
      const location = `${path}/completedSiblings/${index}`;
      const item = requireObject(value, context, location);
      requireKeys(item, ['goalRef', 'assessment'], context, location);
      const goalRef = readGoalRef(item.goalRef, context, `${location}/goalRef`);
      const assessment = readGoalAssessment(
        item.assessment,
        context,
        `${location}/assessment`,
      );
      if (
        assessment.outcome !== 'passed' ||
        assessment.goalRef.id !== goalRef.id ||
        assessment.goalRef.version !== goalRef.version
      )
        throw new ContractError(
          context.code,
          context.stage,
          location,
          'invalid_sibling_result',
        );
      return Object.freeze({ goalRef, assessment });
    }),
  );
  return Object.freeze({
    ...(raw.recentChoices === undefined
      ? {}
      : {
          recentChoices: readChoiceHistory(
            raw.recentChoices,
            context,
            `${path}/recentChoices`,
          ),
        }),
    execution,
    recentResults,
    progress,
    blocker,
    completedSiblings,
  });
}
