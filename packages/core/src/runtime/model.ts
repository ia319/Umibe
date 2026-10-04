import type { CallControl } from '#internal/contracts/control';
import type { JsonObject } from '#internal/contracts/json';
import type {
  ModelIdentity,
  ModelResponseMetadata,
  ModelResponseIssue,
  ModelChoiceMetadata,
} from '#internal/model/metadata';
import {
  captureModelIdentity,
  captureModelResponse,
  captureModelChoice,
} from '#internal/model/validation';
import { captureControl, invokeControlled } from '#internal/candidate/control';
import { ContractError } from '#internal/errors';
import {
  requireObject,
  requireString,
  requireInteger,
} from '#internal/validation/fields';
import { parseJsonValue } from '#internal/validation/json';
import type { RunSession } from './session.js';

export type ModelFailureCode =
  | 'rate_limited'
  | 'unavailable'
  | 'deadline_exceeded'
  | 'unauthorized'
  | 'invalid_request'
  | 'input_limit'
  | 'refused'
  | 'output_truncated'
  | 'invalid_response'
  | 'request_failed';

/**
 * Classify one model attempt without exposing provider error text.
 * Only rate limits, unavailable services and timeouts may be retried. An SDK
 * timeout uses deadline_exceeded; it never extends the caller's total deadline.
 * retryAfterMs is a minimum delay in milliseconds, not a new timeout.
 * Invalid delay or diagnostic fields throw RangeError; diagnostics contain no response values.
 */
export class ModelRequestError extends Error {
  readonly issue: ModelResponseIssue | null;
  constructor(
    readonly code: ModelFailureCode,
    readonly retryAfterMs = 0,
    issue?: ModelResponseIssue,
  ) {
    super(code);
    if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0)
      throw new RangeError('retryAfterMs must be a nonnegative safe integer');
    this.name = 'ModelRequestError';
    if (
      issue !== undefined &&
      (!['protocol', 'planning', 'selection'].includes(issue.phase) ||
        typeof issue.path !== 'string' ||
        issue.path.length > 256 ||
        !/^(?:\/[A-Za-z0-9_-]+)*$/.test(issue.path) ||
        typeof issue.reason !== 'string' ||
        !/^[a-z][a-z0-9_]{0,63}$/.test(issue.reason))
    )
      throw new RangeError(
        'issue must contain a safe phase, path and reason code',
      );
    this.issue =
      issue === undefined
        ? null
        : Object.freeze({
            phase: issue.phase,
            path: issue.path,
            reason: issue.reason,
          });
  }
}

export interface ModelRequestBasis {
  readonly requestId: string;
  readonly decisionEpoch: number;
  readonly purpose: 'planning' | 'selection' | 'candidates' | 'verification';
  readonly model?: ModelIdentity;
}

export type ModelCallResult<T> =
  | {
      readonly outcome: 'returned';
      readonly value: T;
      readonly usage: JsonObject | null;
    }
  | {
      readonly outcome: 'failed';
      readonly reasonCode: ModelFailureCode;
      readonly issue?: ModelResponseIssue;
    }
  | {
      readonly outcome:
        'cancelled' | 'invalidated' | 'budgetExceeded' | 'deadlineExceeded';
    };

/**
 * Dispatch one logical model request with bounded, charged transport attempts.
 * The caller's deadline covers queueing and all retries. Each sent attempt also
 * has the configured model timeout. Local callbacks do not use this gateway.
 * Persistence failures reject and stop the session; missing usage stays unknown.
 */
export async function invokeModel<T>(
  session: RunSession,
  basis: ModelRequestBasis,
  controlInput: CallControl,
  invoke: (
    control: CallControl,
    attempt: number,
  ) => Promise<{ readonly value: T; readonly usage: JsonObject | null }>,
): Promise<ModelCallResult<T>> {
  const validation = {
    code: 'INVALID_RUN_CONTROL',
    stage: 'model_request',
  } as const;
  const request = Object.freeze({
    requestId: requireString(basis.requestId, validation, '/requestId'),
    decisionEpoch: requireInteger(
      basis.decisionEpoch,
      0,
      validation,
      '/decisionEpoch',
    ),
    purpose: basis.purpose,
  });
  if (
    !['planning', 'selection', 'candidates', 'verification'].includes(
      request.purpose,
    )
  )
    throw new ContractError(
      validation.code,
      validation.stage,
      '/purpose',
      'invalid_purpose',
    );
  const captured = captureControl(controlInput);
  const model =
    basis.model === undefined ? null : captureModelIdentity(basis.model);
  const signal = AbortSignal.any([captured.signal, session.signal]);
  const limits = session.state.limits;
  const interruption = ():
    'cancelled' | 'invalidated' | 'deadlineExceeded' | null => {
    if (session.signal.aborted) return 'cancelled';
    if (!session.canDispatch(request.decisionEpoch)) return 'invalidated';
    if (Date.now() >= captured.deadlineMs) return 'deadlineExceeded';
    if (signal.aborted) return 'cancelled';
    return null;
  };

  for (let attempt = 1; attempt <= limits.modelRetries + 1; attempt++) {
    const stopped = interruption();
    if (stopped !== null) return { outcome: stopped };
    if (session.state.modelAttempts >= limits.maxModelAttempts) {
      const cause = session.event(
        'budget_exhausted',
        'model_budget_exhausted',
        { ...request },
      );
      await session.transition(
        {
          kind: 'pause',
          cause: {
            eventId: cause.eventId,
            reasonCode: 'model_budget_exhausted',
          },
        },
        [cause],
      );
      if (
        !session.hasExecution &&
        (session.state.control.status === 'pausing' ||
          session.state.control.status === 'cancelling')
      ) {
        await session.transition({
          kind: 'stopSettled',
          blocker: {
            eventId: cause.eventId,
            reasonCode: 'model_budget_exhausted',
          },
        });
      }
      return { outcome: 'budgetExceeded' };
    }
    const details = {
      ...request,
      attempt,
      model: model === null ? null : { ...model },
    };
    await session.commit(
      {
        ...session.state,
        modelAttempts: session.state.modelAttempts + 1,
        pendingModels: [
          ...session.state.pendingModels,
          { ...request, attempt, phase: 'reserved' },
        ],
      },
      [session.event('model_reserved', 'request_reserved', details)],
    );
    const unsent = interruption();
    if (unsent !== null) {
      await session.commit(
        {
          ...session.state,
          modelAttempts: session.state.modelAttempts - 1,
          pendingModels: session.state.pendingModels.filter(
            (entry) =>
              entry.requestId !== request.requestId ||
              entry.attempt !== attempt,
          ),
        },
        [session.event('model_not_sent', unsent, details)],
      );
      return { outcome: unsent };
    }
    const control = captureControl({
      signal,
      deadlineAt: new Date(
        Math.min(captured.deadlineMs, Date.now() + limits.modelTimeoutMs),
      ).toISOString(),
    });
    let dispatchCommit: Promise<void> | undefined;
    const response: {
      metadata: ModelResponseMetadata | null;
      choice: ModelChoiceMetadata | null;
      open: boolean;
    } = { metadata: null, choice: null, open: true };
    const startedAt = Date.now();
    const result = await invokeControlled(control, (attemptControl) => {
      dispatchCommit = session.commit(
        {
          ...session.state,
          pendingModels: session.state.pendingModels.map((entry) =>
            entry.requestId === request.requestId && entry.attempt === attempt
              ? { ...entry, phase: 'dispatched' }
              : entry,
          ),
        },
        [session.event('model_dispatched', 'request_dispatched', details)],
      );
      return invoke(
        Object.freeze({
          ...attemptControl,
          reportModelResponse: (metadata: ModelResponseMetadata) => {
            if (
              !response.open ||
              response.metadata !== null ||
              attemptControl.signal.aborted ||
              interruption() !== null
            )
              return;
            try {
              response.metadata = captureModelResponse(metadata);
            } catch {
              throw new ModelRequestError('invalid_response');
            }
          },
          reportModelChoice: (metadata: ModelChoiceMetadata) => {
            if (
              !response.open ||
              response.choice !== null ||
              attemptControl.signal.aborted ||
              interruption() !== null
            )
              return;
            try {
              response.choice = captureModelChoice(metadata);
            } catch {
              throw new ModelRequestError('invalid_response');
            }
          },
        }),
        attempt,
      );
    });
    response.open = false;
    await dispatchCommit;
    if (dispatchCommit === undefined) {
      await session.commit(
        {
          ...session.state,
          modelAttempts: session.state.modelAttempts - 1,
          pendingModels: session.state.pendingModels.filter(
            (entry) =>
              entry.requestId !== request.requestId ||
              entry.attempt !== attempt,
          ),
        },
        [session.event('model_not_sent', result.outcome, details)],
      );
      return { outcome: signal.aborted ? 'cancelled' : 'deadlineExceeded' };
    }
    const invalidated = interruption();
    const issue =
      result.outcome === 'failed' && result.error instanceof ModelRequestError
        ? result.error.issue
        : null;
    let usage: JsonObject | null =
      response.metadata?.usage == null ? null : { ...response.metadata.usage };
    let failure: ModelFailureCode | null = null;
    if (result.outcome === 'returned' && response.metadata === null) {
      try {
        usage =
          result.value.usage === null
            ? null
            : requireObject(
                parseJsonValue(result.value.usage, validation.stage),
                validation,
                '/usage',
              );
      } catch {
        failure = 'invalid_response';
      }
    } else if (result.outcome === 'failed') {
      failure =
        result.error instanceof ModelRequestError
          ? result.error.code
          : 'request_failed';
    } else if (result.outcome === 'deadlineExceeded')
      failure = 'deadline_exceeded';
    await session.commit(
      {
        ...session.state,
        pendingModels: session.state.pendingModels.filter(
          (entry) =>
            entry.requestId !== request.requestId || entry.attempt !== attempt,
        ),
      },
      [
        session.event(
          'model_finished',
          (invalidated === null
            ? null
            : session.state.control.stopCause?.reasonCode) ??
            invalidated ??
            failure ??
            result.outcome,
          {
            ...details,
            usage,
            ...(issue === null ? {} : { issue: { ...issue } }),
            ...(response.choice === null
              ? {}
              : { choice: parseJsonValue(response.choice, validation.stage) }),
            response:
              response.metadata === null
                ? null
                : parseJsonValue(response.metadata, validation.stage),
            durationMs: Math.max(0, Date.now() - startedAt),
          },
        ),
      ],
    );
    const afterCommit = interruption();
    if (afterCommit !== null) return { outcome: afterCommit };
    if (invalidated !== null) return { outcome: invalidated };
    if (result.outcome === 'returned' && failure === null)
      return { outcome: 'returned', value: result.value.value, usage };
    if (result.outcome === 'cancelled') return { outcome: 'cancelled' };
    const reasonCode = failure ?? 'request_failed';
    const retryable =
      reasonCode === 'rate_limited' ||
      reasonCode === 'unavailable' ||
      reasonCode === 'deadline_exceeded';
    if (!retryable || attempt > limits.modelRetries)
      return {
        outcome: 'failed',
        reasonCode,
        ...(issue === null ? {} : { issue }),
      };

    const retryAfterMs =
      result.outcome === 'failed' && result.error instanceof ModelRequestError
        ? result.error.retryAfterMs
        : 0;
    const delayMs = Math.max(250 * 2 ** (attempt - 1), retryAfterMs);
    await session.commit(session.state, [
      session.event('model_retry_scheduled', reasonCode, {
        ...details,
        delayMs,
      }),
    ]);
    // A retry delay owns no external work; its deadline simply ends the wait.
    const waited = await invokeControlled(
      captureControl({
        signal,
        deadlineAt: new Date(
          Math.min(Date.now() + delayMs, captured.deadlineMs),
        ).toISOString(),
      }),
      () => new Promise<never>(() => {}),
    );
    if (waited.outcome === 'cancelled') return { outcome: 'cancelled' };
  }
  throw new Error('Unreachable model attempt limit');
}
