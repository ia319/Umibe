/** One invocation owns its cancellation signal; a cancelled call cannot authorize a later effect. */
export interface CallControl {
  readonly signal: AbortSignal;
  /** Absolute UTC deadline, including the time spent waiting for an adapter. */
  readonly deadlineAt: string;
}
