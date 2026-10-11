import { randomUUID } from 'node:crypto';
import type { CallControl } from '#internal/contracts/control';
import type { JsonObject, JsonValue } from '#internal/contracts/json';
import { captureControl, invokeControlled } from '#internal/candidate/control';
import type { InvocationResult } from '#internal/candidate/control';
import { ContractError } from '#internal/errors';
import { parseJsonValue } from '#internal/validation/json';
import { ModelRequestError } from './model.js';
import type { RunSession } from './session.js';

export type CapturedCallbackResponse =
  | { readonly outcome: 'returned'; readonly value: JsonValue }
  | { readonly outcome: 'invalid'; readonly error: unknown }
  | { readonly outcome: 'failed'; readonly error: unknown };

interface CallbackReceiptRequest {
  readonly stage: 'observation' | 'support' | 'checking' | 'rechecking';
  readonly phase:
    'initialization' | 'execution' | 'resume' | 'selection' | 'continuation';
  readonly decisionEpoch: number;
  readonly input: unknown;
}

/**
 * Capture at settlement, before any await or acceptance check.
 * Return detached JSON or the original error; receipt details omit exception text.
 */
export function captureCallbackResponse(
  received:
    | { readonly outcome: 'returned'; readonly value: unknown }
    | { readonly outcome: 'failed'; readonly error: unknown },
  stage: string,
): {
  readonly response: CapturedCallbackResponse;
  readonly details: JsonObject;
} {
  if (received.outcome === 'failed') {
    const error = received.error;
    return {
      response: received,
      details: {
        outcome: 'failed',
        reasonCode:
          error instanceof ModelRequestError
            ? error.code
            : error instanceof ContractError
              ? error.reason
              : 'callback_rejected',
        ...(error instanceof ModelRequestError && error.issue !== null
          ? { issue: { ...error.issue } }
          : error instanceof ContractError
            ? {
                issue: {
                  code: error.code,
                  stage: error.stage,
                  path: error.path,
                  reason: error.reason,
                },
              }
            : {}),
      },
    };
  }
  try {
    const value = parseJsonValue(received.value, stage);
    return {
      response: { outcome: 'returned', value },
      details: { outcome: 'returned', response: value },
    };
  } catch (error) {
    return {
      response: { outcome: 'invalid', error },
      details: {
        outcome: 'returned',
        capture: 'invalid_json',
        ...(error instanceof ContractError
          ? {
              issue: {
                code: error.code,
                stage: error.stage,
                path: error.path,
                reason: error.reason,
              },
            }
          : {}),
      },
    };
  }
}

/**
 * Persist input before invocation and detached output before caller validation.
 * Cancellation bounds acceptance; late fulfillment and rejection stay observed.
 * Receipt persistence requires an open, owned session; failed late writes report
 * receipt_failed. The caller owns lifecycle checks before accepting the result.
 */
export async function captureCallback(
  session: RunSession,
  request: CallbackReceiptRequest,
  controlInput: CallControl,
  current: () => boolean,
  invoke: (control: CallControl) => Promise<unknown>,
): Promise<InvocationResult<JsonValue>> {
  const control = captureControl(controlInput);
  const startedAt = Date.now();
  const { stage, phase, decisionEpoch } = request;
  const identity = { requestId: randomUUID(), decisionEpoch, phase };
  await session.commit(session.state, [
    session.event('callback_started', stage, {
      ...identity,
      input: parseJsonValue(request.input, stage),
    }),
  ]);
  let captureFailure: Error | undefined;
  const result: InvocationResult<JsonValue> = !current()
    ? { outcome: 'cancelled' }
    : await invokeControlled(control, async (callbackControl) => {
        let received:
          | { outcome: 'returned'; value: unknown }
          | { outcome: 'failed'; error: unknown };
        try {
          received = {
            outcome: 'returned',
            value: await invoke(callbackControl),
          };
        } catch (error) {
          received = { outcome: 'failed', error };
        }
        const receivedAt = Date.now();
        const { response, details } = captureCallbackResponse(received, stage);
        if (response.outcome === 'invalid')
          captureFailure =
            response.error instanceof Error
              ? response.error
              : new Error('Callback response capture failed', {
                  cause: response.error,
                });
        const receipt = session.event('callback_received', stage, {
          ...identity,
          invocation: 1,
          receivedAt: new Date(receivedAt).toISOString(),
          currentAtReceipt: current(),
          cancelledAtReceipt: callbackControl.signal.aborted,
          deadlineExceededAtReceipt: receivedAt >= control.deadlineMs,
          ...details,
        });
        try {
          await session.commit(session.state, [receipt]);
        } catch (error) {
          session.report('receipt_failed', receipt.eventId);
          throw error;
        }
        if (response.outcome !== 'returned')
          throw captureFailure ?? response.error;
        return response.value;
      });
  await session.commit(session.state, [
    session.event('callback_finished', stage, {
      ...identity,
      outcome: result.outcome,
      ...(result.outcome === 'returned'
        ? {}
        : {
            reasonCode: `${phase === 'initialization' ? 'initial_observation' : stage}_${result.outcome}`,
          }),
      currentAtReceipt: current(),
      durationMs: Math.max(0, Date.now() - startedAt),
      eventLoopDelay: { samples: 0, meanMs: null, maxMs: null },
    }),
  ]);
  if (
    result.outcome === 'failed' &&
    captureFailure !== undefined &&
    result.error === captureFailure
  )
    throw captureFailure;
  return result;
}
