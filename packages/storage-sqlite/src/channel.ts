import { Worker } from 'node:worker_threads';
import { ContractError, StoreError } from '@umibe/core';
import type {
  StoreCommand,
  StoreReply,
  StoreResponse,
  StoreResults,
} from './protocol.js';

function freezeReply(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeReply(child);
}

/** Correlates Worker requests and fails all callers when the connection becomes uncertain. */
export class WorkerChannel {
  private readonly worker: Worker;
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private readonly pending = new Map<
    number,
    { resolve: (value: StoreReply) => void; reject: (error: Error) => void }
  >();
  private nextId = 0;
  private failure: Error | undefined;
  private closing = false;
  private closingPromise: Promise<void> | undefined;

  constructor(path: string) {
    // The packaged Worker runs JavaScript; caller loaders and --input-type apply only to the caller's entry point.
    this.worker = new Worker(new URL('./worker.js', import.meta.url), {
      workerData: path,
      execArgv: [],
    });
    this.worker.on('message', (response: StoreResponse) => {
      const pending = this.pending.get(response.id);
      if (pending === undefined) return;
      this.pending.delete(response.id);
      if (response.ok) {
        freezeReply(response.value);
        pending.resolve(response.value);
      } else {
        const detail = response.error;
        const error =
          detail.type === 'contract'
            ? new ContractError(
                detail.code,
                detail.stage,
                detail.path,
                detail.reason,
              )
            : new StoreError(detail.code, detail.reason);
        pending.reject(error);
        if (response.fatal) this.fail(error);
      }
    });
    this.worker.on('error', (error) =>
      this.fail(
        new StoreError('STORE_WORKER_FAILED', 'worker_error', { cause: error }),
      ),
    );
    this.worker.on('exit', (code) => {
      if (!this.closing || this.pending.size > 0)
        this.fail(new StoreError('STORE_WORKER_FAILED', `worker_exit_${code}`));
    });
  }

  request<K extends StoreCommand['op']>(
    command: Extract<StoreCommand, { op: K }>,
  ): Promise<StoreResults[K]> {
    return new Promise((resolve, reject) => {
      if (this.failure !== undefined) {
        reject(this.failure);
        return;
      }
      const id = ++this.nextId;
      this.pending.set(id, {
        resolve: (value) => resolve(value as StoreResults[K]),
        reject,
      });
      try {
        this.worker.postMessage({ id, command });
      } catch {
        this.fail(new StoreError('STORE_WORKER_FAILED', 'worker_send_failed'));
      }
    });
  }

  private fail(error: Error): void {
    if (this.signal.aborted) return;
    this.failure = error;
    this.controller.abort(error);
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    void this.worker.terminate();
  }

  close(): Promise<void> {
    this.closingPromise ??= (async () => {
      this.closing = true;
      try {
        if (!this.signal.aborted) await this.request({ op: 'close' });
      } finally {
        await this.worker.terminate();
      }
    })();
    return this.closingPromise;
  }
}
