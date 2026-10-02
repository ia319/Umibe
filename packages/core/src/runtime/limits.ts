import { ContractError } from '#internal/errors';

export interface RuntimeLimits {
  readonly maxModelAttempts: number;
  readonly modelTimeoutMs: number;
  readonly modelRetries: number;
  readonly callbackTimeoutMs: number;
  readonly verificationTimeoutMs: number;
}

export function captureLimits(input: Partial<RuntimeLimits>): RuntimeLimits {
  const limits = {
    maxModelAttempts: 200,
    modelTimeoutMs: 30_000,
    modelRetries: 2,
    callbackTimeoutMs: 10_000,
    verificationTimeoutMs: 30_000,
    ...input,
  };
  for (const [key, value] of Object.entries(limits)) {
    if (
      !Number.isSafeInteger(value) ||
      value < (key === 'modelRetries' || key === 'maxModelAttempts' ? 0 : 1) ||
      (key === 'modelRetries' && value > 2)
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
