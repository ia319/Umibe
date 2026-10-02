export type ContractErrorCode =
  | 'INVALID_JSON'
  | 'INVALID_GOAL_GRAPH'
  | 'INVALID_OBSERVATION'
  | 'INVALID_CANDIDATES'
  | 'INVALID_CANDIDATE_REQUEST'
  | 'INVALID_PLAN_PROPOSAL'
  | 'INVALID_ACTION_DEFINITION'
  | 'INVALID_ACTION_PARAMETERS'
  | 'INVALID_SELECTION'
  | 'INVALID_APPLICATION_EVENT'
  | 'INVALID_RUN_RECORD'
  | 'INVALID_RUN_SUMMARY'
  | 'INVALID_RUN_CHECKPOINT'
  | 'INVALID_STORE_COMMIT'
  | 'INVALID_STORE_QUERY';

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
