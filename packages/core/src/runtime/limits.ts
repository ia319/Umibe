import { ContractError } from '#internal/errors';

export interface RuntimeLimits {
  readonly maxModelAttempts: number;
  readonly modelTimeoutMs: number;
  readonly modelRetries: number;
  readonly callbackTimeoutMs: number;
  readonly verificationTimeoutMs: number;
  readonly maxActionAttempts: number;
  readonly actionTimeoutMs: number;
  readonly stopGraceMs: number;
  readonly actionRetries: number;
}

export function captureLimits(input: Partial<RuntimeLimits>): RuntimeLimits {
  const limits = {
    maxModelAttempts: 200,
    modelTimeoutMs: 30_000,
    modelRetries: 2,
    callbackTimeoutMs: 10_000,
    verificationTimeoutMs: 30_000,
    maxActionAttempts: 100,
    actionTimeoutMs: 60_000,
    stopGraceMs: 5_000,
    actionRetries: 0,
    ...input,
  };
  for (const [key, value] of Object.entries(limits)) {
    if (
      !Number.isSafeInteger(value) ||
      (key.endsWith('Ms') && value > 2_147_483_647) ||
      value < (key.endsWith('Retries') || key.startsWith('max') ? 0 : 1) ||
      (key === 'modelRetries' && value > 2) ||
      (key === 'actionRetries' && value > 1)
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
