import type {
  CandidateContractIssue,
  CandidateStageFailure,
} from '#internal/contracts/candidate-processing';
import { ContractError } from '#internal/errors';
import type { InvocationResult } from './control.js';

export function candidateContractIssue(
  error: unknown,
): CandidateContractIssue | null {
  return error instanceof ContractError
    ? Object.freeze({
        code: error.code,
        stage: error.stage,
        path: error.path,
        reason: error.reason,
      })
    : null;
}

/** Classify adapter failures independently of any error object supplied by the adapter. */
export function invocationFailure(
  result: Exclude<InvocationResult<unknown>, { outcome: 'returned' }>,
  stage: CandidateStageFailure['stage'],
  candidateId: string | null,
): CandidateStageFailure {
  return Object.freeze({
    outcome: result.outcome,
    stage,
    candidateId,
    reason:
      result.outcome === 'failed'
        ? 'callback_failed'
        : result.outcome === 'cancelled'
          ? 'cancelled'
          : 'deadline_exceeded',
    issue: null,
  });
}
