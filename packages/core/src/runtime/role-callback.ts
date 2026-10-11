import type { IntervalHistogram } from 'node:perf_hooks';
import type { CallControl } from '#internal/contracts/control';
import type { ModelStage } from '#internal/contracts/runtime';
import type { ModelIdentity } from '#internal/model/metadata';
import { captureControl, invokeControlled } from '#internal/candidate/control';
import { ContractError } from '#internal/errors';
import { parseJsonValue } from '#internal/validation/json';
import { captureCallbackResponse } from './callback-receipt.js';
import { invokeModel, ModelRequestError } from './model.js';
import type { RunSession } from './session.js';

export type RoleStage =
  | ModelStage
  | 'support'
  | 'observation'
  | 'operations'
  | 'checking'
  | 'filtering';

export type RoleRequest = {
  readonly requestId: string;
  readonly decisionEpoch: number;
  readonly input: unknown;
  readonly retryAttempt?: number;
} & (
  | { readonly stage: RoleStage; readonly accounting: 'local' }
  | {
      readonly stage: ModelStage;
      readonly accounting: 'model';
      readonly model?: ModelIdentity;
    }
  // Only selectors expose per-request charging; other model roles charge the callback.
  | { readonly stage: 'selection'; readonly accounting: 'perRequest' }
);

export type RoleOutcome<T> =
  | { readonly outcome: 'returned'; readonly value: T }
  | { readonly outcome: 'interrupted' }
  | {
      readonly outcome: 'failed';
      readonly reasonCode: string;
      /** Preserve a scheduled batch's model failure for the driver's retry handler. */
      readonly retryError: ModelRequestError | null;
    };

/**
 * Bound and record a role while retaining late raw results and closing its controls.
 * Child model accounting finishes before return. The driver owns blocking and must
 * recheck the decision epoch before accepting output. Storage failures prevent
 * acceptance; direct commit rejections still propagate.
 * The driver keeps the histogram enabled until these bounded calls have drained.
 */
export async function invokeRole<T>(
  session: RunSession,
  basis: RoleRequest,
  control: CallControl,
  delay: IntervalHistogram | null,
  invoke: (control: CallControl) => Promise<T>,
): Promise<RoleOutcome<T>> {
  const { stage, requestId, decisionEpoch: epoch, input, retryAttempt } = basis;
  const startedAt = Date.now();
  await session.commit(session.state, [
    session.event('callback_started', stage, {
      requestId,
      decisionEpoch: epoch,
      input: parseJsonValue(input, stage),
    }),
  ]);
  if (!session.canDispatch(epoch)) return { outcome: 'interrupted' };
  let invocations = 0;
  const invokeRecorded = async (roleControl: CallControl): Promise<T> => {
    const invocation = ++invocations;
    let roleOpen = true;
    const checkRoleOpen = () => {
      if (!roleOpen)
        throw new DOMException('Role invocation settled', 'AbortError');
    };
    // Receipt persistence can outlast the role. Retained controls must stop
    // authorizing model work and metadata as soon as that role settles.
    const bindRoleLifetime = (control: CallControl): CallControl => {
      const requestModel = control.requestModel;
      const recordModelProjection = control.recordModelProjection;
      const recordModelRequest = control.recordModelRequest;
      return Object.freeze<CallControl>({
        ...control,
        ...(requestModel === undefined
          ? {}
          : {
              requestModel: async <R>(
                identity: ModelIdentity,
                request: (child: CallControl) => Promise<R>,
              ): Promise<R> => {
                checkRoleOpen();
                const result = await requestModel(identity, (child) => {
                  checkRoleOpen();
                  return request(bindRoleLifetime(child));
                });
                checkRoleOpen();
                return result;
              },
            }),
        ...(recordModelProjection === undefined
          ? {}
          : {
              recordModelProjection: async (projection) => {
                checkRoleOpen();
                await recordModelProjection(projection);
                checkRoleOpen();
              },
            }),
        ...(recordModelRequest === undefined
          ? {}
          : {
              recordModelRequest: async (request) => {
                checkRoleOpen();
                await recordModelRequest(request);
                checkRoleOpen();
              },
            }),
        ...(control.reportModelResponse === undefined
          ? {}
          : {
              reportModelResponse: (metadata) => {
                if (roleOpen) control.reportModelResponse?.(metadata);
              },
            }),
        ...(control.reportModelChoice === undefined
          ? {}
          : {
              reportModelChoice: (metadata) => {
                if (roleOpen) control.reportModelChoice?.(metadata);
              },
            }),
      });
    };
    let result:
      { outcome: 'returned'; value: T } | { outcome: 'failed'; error: unknown };
    try {
      result = {
        outcome: 'returned',
        value: await invoke(bindRoleLifetime(roleControl)),
      };
    } catch (error) {
      result = { outcome: 'failed', error };
    } finally {
      roleOpen = false;
    }
    const receivedAt = Date.now();
    const { response, details } = captureCallbackResponse(result, stage);
    let invalidResponse: Error | undefined;
    if (response.outcome === 'invalid')
      invalidResponse =
        response.error instanceof Error
          ? response.error
          : new Error('Callback response capture failed', {
              cause: response.error,
            });
    const receipt = session.event('callback_received', stage, {
      requestId,
      invocation,
      decisionEpoch: epoch,
      receivedAt: new Date(receivedAt).toISOString(),
      currentAtReceipt: session.canDispatch(epoch),
      cancelledAtReceipt: roleControl.signal.aborted,
      deadlineExceededAtReceipt:
        receivedAt >= Date.parse(roleControl.deadlineAt),
      ...details,
    });
    try {
      await session.commit(session.state, [receipt]);
    } catch (error) {
      session.report('receipt_failed', receipt.eventId);
      throw error;
    }
    if (response.outcome !== 'returned')
      throw invalidResponse ?? response.error;
    // All callback contracts return JSON; retain the captured value for downstream validation.
    return response.value as T;
  };
  const modelRequests = new Set<Promise<unknown>>();
  const result =
    basis.accounting === 'model'
      ? await invokeModel(
          session,
          {
            requestId,
            decisionEpoch: epoch,
            purpose: basis.stage,
            ...(basis.model === undefined ? {} : { model: basis.model }),
            ...(retryAttempt === undefined ? {} : { retryAttempt }),
          },
          control,
          async (control) => ({
            value: await invokeRecorded(control),
            usage: null,
          }),
        )
      : await invokeControlled(captureControl(control), async (roleControl) => {
          if (basis.accounting !== 'perRequest')
            return invokeRecorded(roleControl);
          let pending: Promise<unknown> | null = null;
          let sequence = 0;
          return await invokeRecorded({
            ...roleControl,
            requestModel: async <R>(
              identity: ModelIdentity,
              request: (child: CallControl) => Promise<R>,
            ): Promise<R> => {
              if (roleControl.signal.aborted || !session.canDispatch(epoch))
                throw new DOMException('Model request cancelled', 'AbortError');
              if (pending !== null)
                throw new ContractError(
                  'INVALID_RUN_CONTROL',
                  'model_request',
                  '/control/requestModel',
                  'concurrent_model_request',
                );
              if (retryAttempt !== undefined && sequence !== 0)
                throw new ContractError(
                  'INVALID_RUN_CONTROL',
                  'model_request',
                  '/control/requestModel',
                  'multiple_batch_requests',
                );
              const child = invokeModel(
                session,
                {
                  requestId: `${requestId}/model-${++sequence}`,
                  decisionEpoch: epoch,
                  purpose: 'selection',
                  model: identity,
                  ...(retryAttempt === undefined ? {} : { retryAttempt }),
                },
                roleControl,
                async (childControl) => ({
                  value: await request(childControl),
                  usage: null,
                }),
              );
              pending = child;
              modelRequests.add(child);
              try {
                const answer = await child;
                if (answer.outcome === 'returned') return answer.value;
                if (answer.outcome === 'failed')
                  throw new ModelRequestError(
                    answer.reasonCode,
                    answer.retryAfterMs ?? 0,
                    answer.issue,
                  );
                if (answer.outcome === 'deadlineExceeded')
                  throw new ModelRequestError('deadline_exceeded');
                throw new DOMException('Model request cancelled', 'AbortError');
              } finally {
                pending = null;
                modelRequests.delete(child);
              }
            },
          });
        });
  // The enclosing timeout can settle before a child finishes persisting its usage.
  await Promise.allSettled(modelRequests);
  if (session.failure !== null) return { outcome: 'interrupted' };
  const accepted = session.canDispatch(epoch);
  const reasonCode =
    session.state.control.stopCause?.reasonCode ??
    (result.outcome === 'failed' && 'reasonCode' in result
      ? result.reasonCode
      : result.outcome === 'failed' &&
          'error' in result &&
          result.error instanceof ModelRequestError
        ? result.error.code
        : basis.accounting === 'model' && result.outcome === 'deadlineExceeded'
          ? 'deadline_exceeded'
          : `${stage}_${result.outcome}`);
  const sampled = delay !== null && delay.count > 0;
  await session.commit(session.state, [
    session.event('callback_finished', stage, {
      requestId,
      decisionEpoch: epoch,
      outcome: result.outcome,
      ...(result.outcome !== 'returned' ? { reasonCode } : {}),
      ...('issue' in result && result.issue !== undefined
        ? { issue: { ...result.issue } }
        : {}),
      currentAtReceipt: accepted,
      durationMs: Math.max(0, Date.now() - startedAt),
      eventLoopDelay: {
        samples: delay?.count ?? 0,
        meanMs: sampled ? delay.mean / 1_000_000 : null,
        maxMs: sampled ? delay.max / 1_000_000 : null,
      },
    }),
  ]);
  if (!session.canDispatch(epoch)) return { outcome: 'interrupted' };
  if (result.outcome === 'returned')
    return { outcome: 'returned', value: result.value };
  let retryError: ModelRequestError | null = null;
  if (retryAttempt !== undefined && result.outcome === 'failed') {
    if ('error' in result && result.error instanceof ModelRequestError)
      retryError = result.error;
    else if ('reasonCode' in result)
      retryError = new ModelRequestError(
        result.reasonCode,
        result.retryAfterMs ?? 0,
        result.issue,
      );
  }
  return { outcome: 'failed', reasonCode, retryError };
}
