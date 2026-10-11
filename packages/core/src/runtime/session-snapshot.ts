import type { JsonObject } from '#internal/contracts/json';
import { requireObject } from '#internal/validation/fields';
import { parseJsonValue } from '#internal/validation/json';
import type { SessionState } from './session.js';

export interface SessionSnapshot {
  readonly state: SessionState;
  readonly checkpointState: JsonObject;
}

const validation = {
  code: 'INVALID_RUN_CONTROL',
  stage: 'run_session',
} as const;

/**
 * Project runtime context and capture immutable state for admission and persistence.
 * The live state freezes input descendants in place to retain execution identities;
 * checkpointState is detached JSON. Callers must provide detached, validated state.
 */
export function captureSessionSnapshot(state: SessionState): SessionSnapshot {
  const path = new Set(
    state.decision.context.graph.goalPath.map((ref) => ref.id),
  );
  state = {
    ...state,
    decision: Object.freeze({
      ...state.decision,
      context: Object.freeze({
        ...state.decision.context,
        runtime: Object.freeze({
          execution:
            state.execution === null
              ? null
              : Object.freeze({
                  executionId: state.execution.intent.executionId,
                  phase: state.execution.phase,
                  intent: state.execution.intent,
                  progress: state.execution.progress,
                  stopCause: state.execution.stopCause,
                }),
          recentResults: state.recentResults,
          progress: Object.freeze(
            state.progress
              .filter(({ goalRef }) =>
                state.decision.context.graph.goals.some(
                  (goal) =>
                    goal.id === goalRef.id && goal.version === goalRef.version,
                ),
              )
              .map(({ goalRef, noProgress, recoveryAttempts, highWater }) =>
                Object.freeze({
                  goalRef,
                  noProgress,
                  recoveryAttempts,
                  highWater,
                }),
              ),
          ),
          blocker: state.control.blocker,
          completedSiblings: Object.freeze(
            state.decision.context.graph.goals
              .filter(
                (goal) =>
                  !path.has(goal.id) &&
                  goal.lifecycle === 'succeeded' &&
                  goal.parentGoalRef !== null &&
                  path.has(goal.parentGoalRef.id),
              )
              .flatMap((goal) =>
                goal.lastAssessment === null
                  ? []
                  : [
                      Object.freeze({
                        goalRef: { id: goal.id, version: goal.version },
                        assessment: goal.lastAssessment,
                      }),
                    ],
              ),
          ),
        }),
      }),
    }),
  };
  const checkpointState = requireObject(
    parseJsonValue(state, validation.stage),
    validation,
    '/state',
  );
  const pendingObjects: object[] = [state];
  const frozen = new Set<object>();
  while (pendingObjects.length > 0) {
    const value = pendingObjects.pop()!;
    if (frozen.has(value)) continue;
    frozen.add(value);
    Object.freeze(value);
    const children: unknown[] = Object.values(value);
    for (const child of children)
      if (child !== null && typeof child === 'object')
        pendingObjects.push(child);
  }
  return Object.freeze({ state, checkpointState });
}
