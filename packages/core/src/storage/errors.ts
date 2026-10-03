/** A closed store cannot serve reads or accept new commits. */
export class StoreClosedError extends Error {
  readonly code = 'STORE_CLOSED' as const;

  constructor(
    public readonly operation:
      'readRun' | 'readRecords' | 'readRecord' | 'commit' | 'acquireRun',
  ) {
    super(`Cannot ${operation}: store is closed`);
    this.name = 'StoreClosedError';
  }
}

/** Storage failures are classified without interpreting database error text. */
export class StoreError extends Error {
  constructor(
    readonly code:
      | 'STORE_OWNERSHIP'
      | 'STORE_FAILED'
      | 'STORE_BUSY'
      | 'STORE_CORRUPT'
      | 'STORE_VERSION'
      | 'STORE_WORKER_FAILED',
    readonly reason: string,
  ) {
    super(`${code}: ${reason}`);
    this.name = 'StoreError';
  }
}
