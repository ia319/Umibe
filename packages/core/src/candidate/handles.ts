import type { PreparedAction } from '#internal/contracts/action';
import type { PreparedCandidates } from '#internal/contracts/candidate-processing';
import { ContractError } from '#internal/errors';

const preparedCalls = new WeakMap<
  PreparedCandidates,
  ReadonlyMap<string, PreparedAction>
>();

/** Attach implementations only to the exact immutable token created by preparation. */
export function registerPreparedCandidates(
  data: PreparedCandidates,
  calls: ReadonlyMap<string, PreparedAction>,
): PreparedCandidates {
  const token = Object.freeze(data);
  preparedCalls.set(token, new Map(calls));
  return token;
}

export function getPreparedCalls(
  prepared: PreparedCandidates,
): ReadonlyMap<string, PreparedAction> {
  const calls = preparedCalls.get(prepared);
  if (calls === undefined) {
    throw new ContractError(
      'INVALID_CANDIDATE_REQUEST',
      'candidate_checking',
      '',
      'unprepared_candidates',
    );
  }
  return calls;
}
