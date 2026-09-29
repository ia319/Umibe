/** A closed store cannot serve reads or accept new commits. */
export class StoreClosedError extends Error {
  readonly code = 'STORE_CLOSED' as const;

  constructor(public readonly operation: 'readRun' | 'readRecords' | 'commit') {
    super(`Cannot ${operation}: store is closed`);
    this.name = 'StoreClosedError';
  }
}
