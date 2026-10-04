import type { CallControl } from '#internal/contracts/control';
import { ContractError } from '#internal/errors';
import { requireTimestamp } from '#internal/validation/fields';

export interface CapturedControl extends CallControl {
  readonly deadlineMs: number;
}

export type InvocationResult<T> =
  | { readonly outcome: 'returned'; readonly value: T }
  | { readonly outcome: 'failed'; readonly error: unknown }
  | { readonly outcome: 'cancelled' | 'deadlineExceeded' };

export function captureControl(input: CallControl): CapturedControl {
  if (
    typeof input !== 'object' ||
    input === null ||
    !(input.signal instanceof AbortSignal)
  ) {
    throw new ContractError(
      'INVALID_CANDIDATE_REQUEST',
      'candidate_request',
      '/control/signal',
      'expected_abort_signal',
    );
  }
  const deadlineAt = requireTimestamp(
    input.deadlineAt,
    {
      code: 'INVALID_CANDIDATE_REQUEST',
      stage: 'candidate_request',
    },
    '/control/deadlineAt',
  );
  if (
    input.reportModelResponse !== undefined &&
    typeof input.reportModelResponse !== 'function'
  )
    throw new ContractError(
      'INVALID_CANDIDATE_REQUEST',
      'candidate_request',
      '/control/reportModelResponse',
      'expected_function',
    );
  return Object.freeze({
    signal: input.signal,
    deadlineAt,
    deadlineMs: Date.parse(deadlineAt),
    ...(input.reportModelResponse === undefined
      ? {}
      : { reportModelResponse: input.reportModelResponse }),
  });
}

/**
 * Bound acceptance of one asynchronous result. Each invocation gets its own
 * signal; cancellation ends waiting without claiming the adapter has stopped.
 * Both fulfillment and rejection remain observed after the boundary settles.
 */
export function invokeControlled<T>(
  control: CapturedControl,
  invoke: (control: CallControl) => Promise<T>,
): Promise<InvocationResult<T>> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const invocationControl = Object.freeze({
      signal: controller.signal,
      deadlineAt: control.deadlineAt,
      ...(control.reportModelResponse === undefined
        ? {}
        : { reportModelResponse: control.reportModelResponse }),
    });
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const interruption = (): 'cancelled' | 'deadlineExceeded' | null =>
      control.signal.aborted
        ? 'cancelled'
        : Date.now() >= control.deadlineMs
          ? 'deadlineExceeded'
          : null;
    const finish = (result: InvocationResult<T>) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      control.signal.removeEventListener('abort', cancel);
      if (
        result.outcome === 'cancelled' ||
        result.outcome === 'deadlineExceeded'
      )
        controller.abort();
      resolve(result);
    };
    const cancel = () => finish({ outcome: 'cancelled' });
    const scheduleDeadline = () => {
      const stopped = interruption();
      if (stopped !== null) {
        finish({ outcome: stopped });
        return;
      }
      // Node timers clamp larger delays to 1 ms; re-arm long deadlines instead.
      timer = setTimeout(
        scheduleDeadline,
        Math.min(control.deadlineMs - Date.now(), 2_147_483_647),
      );
    };

    const stopped = interruption();
    if (stopped !== null) {
      finish({ outcome: stopped });
      return;
    }
    control.signal.addEventListener('abort', cancel, { once: true });
    scheduleDeadline();
    if (settled) return;
    let promise: Promise<T>;
    try {
      promise = invoke(invocationControl);
    } catch (error) {
      const stopped = interruption();
      finish(
        stopped === null ? { outcome: 'failed', error } : { outcome: stopped },
      );
      return;
    }
    Promise.resolve(promise).then(
      (value) => {
        const stopped = interruption();
        finish(
          stopped === null
            ? { outcome: 'returned', value }
            : { outcome: stopped },
        );
      },
      (error: unknown) => {
        const stopped = interruption();
        finish(
          stopped === null
            ? { outcome: 'failed', error }
            : { outcome: stopped },
        );
      },
    );
  });
}
