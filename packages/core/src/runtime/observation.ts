import { randomUUID } from 'node:crypto';
import type { ObservationSource } from '#internal/contracts/adapters';
import type { CallControl } from '#internal/contracts/control';
import type { DecisionContext } from '#internal/contracts/context';
import type { JsonObject, JsonValue } from '#internal/contracts/json';
import { captureControl, invokeControlled } from '#internal/candidate/control';
import type { InvocationResult } from '#internal/candidate/control';
import { ContractError } from '#internal/errors';
import { parseJsonValue } from '#internal/validation/json';
import { ModelRequestError } from './model.js';
import type { RunSession } from './session.js';

/**
 * Capture source snapshots without extending acceptance past the caller's deadline.
 * Late receipts stay observed. Callers validate observation shape, run identity,
 * and revisions before updating state; null context preserves initialization semantics.
 */
export async function captureObservation(
  session: RunSession,
  source: ObservationSource,
  context: DecisionContext | null,
  controlInput: CallControl,
): Promise<InvocationResult<JsonValue>> {
  const control = captureControl(controlInput);
  const requestId = randomUUID();
  const epoch = session.state.decision.decisionEpoch;
  const startedAt = Date.now();
  const current = () =>
    session.state.observations.initialized
      ? session.canDispatch(epoch)
      : session.failure === null &&
        !session.ownershipSignal.aborted &&
        !control.signal.aborted &&
        session.state.decision.decisionEpoch === epoch &&
        ['created', 'paused'].includes(session.state.control.status);
  const request = {
    requestId,
    decisionEpoch: epoch,
    phase: context === null ? 'initialization' : 'execution',
  };
  await session.commit(session.state, [
    session.event('callback_started', 'observation', {
      ...request,
      input: parseJsonValue(context, 'observation'),
    }),
  ]);
  let captureFailure: Error | undefined;
  const result: InvocationResult<JsonValue> = !current()
    ? { outcome: 'cancelled' }
    : await invokeControlled(control, async (snapshotControl) => {
        let received:
          | { outcome: 'returned'; value: unknown }
          | { outcome: 'failed'; error: unknown };
        try {
          received = {
            outcome: 'returned',
            value: await source.snapshot(context, snapshotControl),
          };
        } catch (error) {
          received = { outcome: 'failed', error };
        }
        const receivedAt = Date.now();
        let response: JsonValue | undefined;
        let details: JsonObject;
        if (received.outcome === 'returned') {
          try {
            // Copy the source value before persistence or observation validation can await.
            response = parseJsonValue(received.value, 'observation');
            details = { outcome: 'returned', response };
          } catch (error) {
            captureFailure =
              error instanceof Error
                ? error
                : new Error('Observation response capture failed', {
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
        const receipt = session.event('callback_received', 'observation', {
          ...request,
          invocation: 1,
          receivedAt: new Date(receivedAt).toISOString(),
          currentAtReceipt: current(),
          cancelledAtReceipt: snapshotControl.signal.aborted,
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
            captureFailure ?? new Error('Observation response was not captured')
          );
        return response;
      });
  await session.commit(session.state, [
    session.event('callback_finished', 'observation', {
      ...request,
      outcome: result.outcome,
      ...(result.outcome === 'returned'
        ? {}
        : {
            reasonCode: `${context === null ? 'initial_observation' : 'observation'}_${result.outcome}`,
          }),
      currentAtReceipt: current(),
      durationMs: Math.max(0, Date.now() - startedAt),
      eventLoopDelay: { samples: 0, meanMs: null, maxMs: null },
    }),
  ]);
  // Keep malformed JSON distinct from an adapter that rejected its snapshot call.
  if (
    result.outcome === 'failed' &&
    captureFailure !== undefined &&
    result.error === captureFailure
  )
    throw captureFailure;
  return result;
}
