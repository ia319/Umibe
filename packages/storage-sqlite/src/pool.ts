import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { StoreError } from '@umibe/core';
import { WorkerChannel } from './channel.js';

/** Resolve existing symlinks without creating missing database files or directories. */
export function canonicalDatabasePath(input: string): string {
  if (typeof input !== 'string' || input.trim() === '' || input.includes('\0'))
    throw new TypeError('SQLite requires a file path');
  let ancestor = resolve(input);
  const missing: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(ancestor), ...missing.reverse());
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      )
        throw new StoreError('STORE_FAILED', 'path_resolution_failed', {
          cause: error,
        });
      const parent = dirname(ancestor);
      if (parent === ancestor)
        throw new StoreError('STORE_FAILED', 'path_resolution_failed', {
          cause: error,
        });
      missing.push(basename(ancestor));
      ancestor = parent;
    }
  }
}

interface SharedWorker {
  readonly ready: Promise<WorkerChannel>;
  readonly controller: AbortController;
  references: number;
  closing: Promise<void> | undefined;
}

const workers = new Map<string, SharedWorker>();

/** Each handle owns its run leases; the final release drains and closes the shared Worker. */
export function retainWorker(
  path: string,
  clientId: string,
): {
  readonly ready: Promise<WorkerChannel>;
  readonly signal: AbortSignal;
  release(): Promise<void>;
} {
  const key = process.platform === 'win32' ? path.toLowerCase() : path;
  let shared = workers.get(key);
  if (shared === undefined || shared.closing !== undefined) {
    const previousClose = shared?.closing;
    const controller = new AbortController();
    const ready = Promise.resolve(previousClose).then(() => {
      const channel = new WorkerChannel(path);
      channel.signal.addEventListener(
        'abort',
        () => controller.abort(channel.signal.reason),
        { once: true },
      );
      return channel;
    });
    // A constructor can fail before there are requests; still notify every retained store.
    void ready.catch((error: unknown) => controller.abort(error));
    shared = { ready, controller, references: 0, closing: undefined };
    workers.set(key, shared);
  }
  const entry = shared;
  entry.references++;
  let released: Promise<void> | undefined;
  return {
    ready: entry.ready,
    signal: entry.controller.signal,
    release(): Promise<void> {
      if (released !== undefined) return released;
      const drain = entry.ready.then(async (channel) => {
        if (!channel.signal.aborted)
          await channel.request({ op: 'releaseClient', clientId });
      });
      entry.references--;
      if (entry.references === 0) {
        entry.closing = drain.finally(async () => {
          try {
            const channel = await entry.ready;
            await channel.close();
          } finally {
            if (workers.get(key) === entry) workers.delete(key);
          }
        });
        released = entry.closing;
      } else released = drain;
      return released;
    },
  };
}
