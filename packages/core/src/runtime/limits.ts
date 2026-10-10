import { ContractError } from '#internal/errors';

/** Set a max-prefixed limit to null to disable that count limit; usage is still recorded. */
export interface RuntimeLimits {
  readonly maxModelAttempts: number | null;
  readonly modelTimeoutMs: number;
  readonly modelRetries: number;
  readonly callbackTimeoutMs: number;
  readonly verificationTimeoutMs: number;
  readonly maxActionAttempts: number | null;
  readonly actionTimeoutMs: number;
  readonly stopGraceMs: number;
  readonly actionRetries: number;
  /** Root depth is zero. */
  readonly maxGoalDepth: number | null;
  /** Cumulative new child IDs, including closed and invalidated goals. */
  readonly maxSubgoals: number | null;
  readonly maxNoProgress: number | null;
  readonly maxRecoveryAttempts: number | null;
}

export function captureLimits(input: Partial<RuntimeLimits>): RuntimeLimits {
  const defaults: RuntimeLimits = {
    maxModelAttempts: 200,
    modelTimeoutMs: 30_000,
    modelRetries: 2,
    callbackTimeoutMs: 10_000,
    verificationTimeoutMs: 30_000,
    maxActionAttempts: 100,
    actionTimeoutMs: 60_000,
    stopGraceMs: 5_000,
    actionRetries: 0,
    maxGoalDepth: 8,
    maxSubgoals: 100,
    maxNoProgress: 3,
    maxRecoveryAttempts: 3,
  };
  for (const key of Object.keys(input))
    if (!Object.hasOwn(defaults, key))
      throw new ContractError(
        'INVALID_RUN_CONTROL',
        'runtime_limits',
        `/${key}`,
        'unknown_limit',
      );
  const limits = { ...defaults, ...input };
  for (const [key, value] of Object.entries(limits)) {
    if (value === null && key.startsWith('max')) continue;
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      (key.endsWith('Ms') && value > 2_147_483_647) ||
      value < (key.endsWith('Retries') || key.startsWith('max') ? 0 : 1) ||
      (key === 'modelRetries' && value > 2) ||
      (key === 'actionRetries' && value > 1) ||
      ((key === 'maxNoProgress' || key === 'maxRecoveryAttempts') && value < 1)
    ) {
      throw new ContractError(
        'INVALID_RUN_CONTROL',
        'runtime_limits',
        `/${key}`,
        'invalid_limit',
      );
    }
  }
  return Object.freeze(limits);
}
