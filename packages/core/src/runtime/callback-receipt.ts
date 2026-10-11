import { randomUUID } from 'node:crypto';
import type { CallControl } from '#internal/contracts/control';
import type { JsonObject, JsonValue } from '#internal/contracts/json';
import { captureControl, invokeControlled } from '#internal/candidate/control';
import type { InvocationResult } from '#internal/candidate/control';
import { ContractError } from '#internal/errors';
import { parseJsonValue } from '#internal/validation/json';
import { ModelRequestError } from './model.js';
import type { RunSession } from './session.js';

interface CallbackReceiptRequest {
  readonly stage: 'observation' | 'support';
  readonly phase: 'initialization' | 'execution' | 'resume';
  readonly decisionEpoch: number;
  readonly input: unknown;
}

/**
 * Persist input before invocation and detached output before caller validation.
 * Cancellation bounds acceptance, while late fulfillment and rejection still
 * produce receipts. The caller owns lifecycle checks before accepting the result.
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
        let response: JsonValue | undefined;
        let details: JsonObject;
        if (received.outcome === 'returned') {
          try {
            response = parseJsonValue(received.value, stage);
            details = { outcome: 'returned', response };
          } catch (error) {
            captureFailure =
              error instanceof Error
                ? error
                : new Error('Callback response capture failed', {
                    cause: error,
                  });
            details = {
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
            };
          }
        } else {
          const error = received.error;
          details = {
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
          };
        }
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
        if (received.outcome === 'failed') throw received.error;
        if (response === undefined)
          throw (
            captureFailure ?? new Error('Callback response was not captured')
          );
        return response;
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
