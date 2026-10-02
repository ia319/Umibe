import type { GoalAssessment } from '#internal/contracts/goal';
import type { GoalRef, ObservationRef } from '#internal/contracts/references';
import type { RunStatus } from '#internal/contracts/record';
import { ContractError } from '#internal/errors';
import { readGoalAssessment } from '#internal/validation/assessment';
import { requireObject, requireString } from '#internal/validation/fields';
import { parseJsonValue } from '#internal/validation/json';
import { readGoalRef } from '#internal/validation/references';

export interface RunCause {
  readonly eventId: string;
  readonly reasonCode: string;
}

export interface RunControlState {
  readonly status: RunStatus;
  readonly rootGoalRef: GoalRef;
  readonly stopCause: RunCause | null;
  readonly blocker: RunCause | null;
}

export type RunCommand =
  | { readonly kind: 'start' | 'resume' }
  | { readonly kind: 'pause' | 'cancel' | 'fail'; readonly cause: RunCause }
  | { readonly kind: 'stopSettled'; readonly blocker: RunCause | null }
  | {
      readonly kind: 'succeed';
      readonly assessment: GoalAssessment;
      readonly observationRef: ObservationRef;
    };

const context = { code: 'INVALID_RUN_CONTROL', stage: 'run_control' } as const;

export function createRunControl(rootGoalRef: GoalRef): RunControlState {
  return Object.freeze({
    status: 'created',
    rootGoalRef: readGoalRef(
      parseJsonValue(rootGoalRef, context.stage),
      context,
      '/rootGoalRef',
    ),
    stopCause: null,
    blocker: null,
  });
}

function captureCause(input: RunCause): RunCause {
  const value = requireObject(
    parseJsonValue(input, context.stage),
    context,
    '/cause',
  );
  return Object.freeze({
    eventId: requireString(value.eventId, context, '/cause/eventId'),
    reasonCode: requireString(value.reasonCode, context, '/cause/reasonCode'),
  });
}

/** Pure control transitions; the execution coordinator confirms stop boundaries separately. */
export function transitionRun(
  state: RunControlState,
  command: RunCommand,
): RunControlState {
  const terminal =
    state.status === 'cancelled' ||
    state.status === 'succeeded' ||
    state.status === 'failed';
  if (terminal) {
    if (command.kind === 'cancel' && state.status === 'cancelled') return state;
    throw new ContractError(
      context.code,
      context.stage,
      '/status',
      'terminal_run',
    );
  }
  switch (command.kind) {
    case 'start':
    case 'resume': {
      const expected = command.kind === 'start' ? 'created' : 'paused';
      if (state.status !== expected) break;
      return Object.freeze({
        ...state,
        status: 'running',
        stopCause: null,
        blocker: null,
      });
    }
    case 'pause':
    case 'cancel': {
      const cause = captureCause(command.cause);
      if (
        command.kind === 'pause' &&
        (state.status === 'pausing' ||
          state.status === 'paused' ||
          state.status === 'cancelling')
      )
        return state;
      if (command.kind === 'cancel' && state.status === 'cancelling')
        return state;
      return Object.freeze({
        ...state,
        status: command.kind === 'pause' ? 'pausing' : 'cancelling',
        stopCause: state.stopCause ?? cause,
      });
    }
    case 'stopSettled': {
      if (state.status !== 'pausing' && state.status !== 'cancelling') break;
      return Object.freeze({
        ...state,
        status: state.status === 'pausing' ? 'paused' : 'cancelled',
        blocker:
          command.blocker === null ? null : captureCause(command.blocker),
      });
    }
    case 'fail': {
      const cause = captureCause(command.cause);
      // Cancellation remains authoritative when cleanup also fails.
      if (state.status === 'cancelling')
        return Object.freeze({ ...state, blocker: cause });
      return Object.freeze({
        ...state,
        status: 'failed',
        stopCause: state.stopCause ?? cause,
        blocker: cause,
      });
    }
    case 'succeed': {
      if (state.status !== 'running') break;
      const assessment = readGoalAssessment(
        parseJsonValue(command.assessment, context.stage),
        context,
        '/assessment',
      );
      if (
        assessment.outcome !== 'passed' ||
        assessment.goalRef.id !== state.rootGoalRef.id ||
        assessment.goalRef.version !== state.rootGoalRef.version ||
        assessment.observationRef.id !== command.observationRef.id ||
        assessment.observationRef.revision !== command.observationRef.revision
      ) {
        throw new ContractError(
          context.code,
          context.stage,
          '/assessment',
          'unverified_root',
        );
      }
      return Object.freeze({ ...state, status: 'succeeded' });
    }
  }
  throw new ContractError(
    context.code,
    context.stage,
    '/status',
    'invalid_transition',
  );
}
