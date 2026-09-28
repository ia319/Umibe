export type ContractErrorCode = 'INVALID_JSON';

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
