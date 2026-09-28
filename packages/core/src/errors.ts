export type ContractErrorCode =
  'INVALID_JSON' | 'INVALID_GOAL_GRAPH' | 'INVALID_OBSERVATION';

/** Identifies an invalid contract without retaining the rejected value. */
export class ContractError extends Error {
  constructor(
    public readonly code: ContractErrorCode,
    public readonly stage: string,
    public readonly path: string,
    public readonly reason: string,
  ) {
    super(`${code} at ${stage}${path}: ${reason}`);
    this.name = 'ContractError';
  }
}
