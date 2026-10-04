import {
  createAgent as createCoreAgent,
  ContractError,
  MemoryRunStore,
} from '@umibe/core';
import type {
  Agent as CoreAgent,
  AgentOptions as CoreAgentOptions,
  JsonValue,
  RunInspection as CoreRunInspection,
} from '@umibe/core';
import { SqliteRunStore } from '@umibe/storage-sqlite';
import type { SqliteInspection } from '@umibe/storage-sqlite';
import { resolveDatabasePath } from './path.js';

export * from '@umibe/core';

export type Persistence =
  | { readonly mode?: 'sqlite'; readonly path?: string }
  | { readonly mode: 'memory' };

type SharedOptions<TCriteria extends JsonValue> = Omit<
  CoreAgentOptions<TCriteria>,
  'store' | 'applicationId'
> & {
  /** Resolve relative roots from the initial cwd; otherwise find its nearest package.json ancestor. */
  readonly projectRoot?: string;
};

export type AgentOptions<TCriteria extends JsonValue = JsonValue> =
  SharedOptions<TCriteria> &
    (
      | {
          readonly applicationId: string;
          readonly persistence?: Extract<Persistence, { mode?: 'sqlite' }>;
        }
      | {
          readonly applicationId?: string;
          readonly persistence: Extract<Persistence, { mode: 'memory' }>;
        }
    );

export type StorageInfo = MemoryRunStore['info'] | SqliteRunStore['info'];
export type StorageInspection = StorageInfo & SqliteInspection;

export interface RunInspection extends CoreRunInspection {
  readonly storage: StorageInspection;
}

export interface Agent extends CoreAgent {
  /** The fixed effective location, available without a query or ownership claim. */
  readonly storage: StorageInfo;
  /** Read database presence and its persisted owner; never acquire execution rights. */
  inspect(): Promise<StorageInspection>;
  inspect(runId: string): Promise<RunInspection | null>;
  /** Release this SDK's store reference after every owned run can close. */
  close(): Promise<void>;
}

/**
 * Create a runner with SQLite persistence by default, or an explicit memory store.
 * Durable runs require a stable applicationId. Paths remain fixed after creation;
 * missing databases are initialized only when a run first acquires execution rights.
 * Importing this module creates neither files nor Workers. Never falls back to memory.
 */
export function createAgent<TCriteria extends JsonValue>(
  input: AgentOptions<TCriteria>,
): Agent {
  if (Object.hasOwn(input, 'store'))
    throw new ContractError(
      'INVALID_RUN_CONTROL',
      'sdk',
      '/store',
      'use_core_for_injected_store',
    );
  const { persistence, projectRoot, ...options } = input;
  if (
    persistence !== undefined &&
    (persistence === null ||
      typeof persistence !== 'object' ||
      Array.isArray(persistence))
  )
    throw new ContractError(
      'INVALID_RUN_CONTROL',
      'sdk',
      '/persistence',
      'invalid_persistence',
    );
  const mode = persistence?.mode ?? 'sqlite';
  if (mode !== 'sqlite' && mode !== 'memory')
    throw new ContractError(
      'INVALID_RUN_CONTROL',
      'sdk',
      '/persistence/mode',
      'invalid_persistence_mode',
    );
  for (const key of Object.keys(persistence ?? {}))
    if (key !== 'mode' && (key !== 'path' || mode === 'memory'))
      throw new ContractError(
        'INVALID_RUN_CONTROL',
        'sdk',
        `/persistence/${key}`,
        'unknown_field',
      );
  if (
    mode === 'sqlite' &&
    (typeof input.applicationId !== 'string' ||
      input.applicationId.trim() === '')
  )
    throw new ContractError(
      'INVALID_RUN_CONTROL',
      'sdk',
      '/applicationId',
      'missing_application_id',
    );
  const store =
    mode === 'memory'
      ? new MemoryRunStore()
      : new SqliteRunStore(
          resolveDatabasePath(
            projectRoot,
            persistence !== undefined && 'path' in persistence
              ? persistence.path
              : undefined,
            process.cwd(),
          ),
        );
  let core: CoreAgent;
  try {
    core = createCoreAgent({ ...options, store });
  } catch (error) {
    // Validation is synchronous; release the unused store even though no agent can be returned.
    void store.close().catch(() => undefined);
    throw error;
  }
  let closing: Promise<void> | undefined;
  async function storageInspection(): Promise<StorageInspection> {
    if (store instanceof SqliteRunStore)
      return Object.freeze({ ...store.info, ...(await store.inspect()) });
    // Match closed-store query behavior without exposing the SDK-owned mutable store.
    if (store.signal.aborted) throw store.signal.reason;
    return Object.freeze({
      ...store.info,
      exists: false,
      schemaVersion: null,
      owner: null,
    });
  }
  function inspect(): Promise<StorageInspection>;
  function inspect(runId: string): Promise<RunInspection | null>;
  async function inspect(
    runId?: string,
  ): Promise<StorageInspection | RunInspection | null> {
    const storage = await storageInspection();
    if (runId === undefined) return storage;
    const run = await core.inspect(runId);
    return run === null ? null : Object.freeze({ ...run, storage });
  }
  return Object.freeze({
    ...core,
    storage: store.info,
    inspect,
    async close(): Promise<void> {
      if (closing !== undefined) return closing;
      await core.close();
      closing = store.close();
      await closing;
    },
  });
}
