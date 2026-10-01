import type { CandidateSet } from '#internal/contracts/candidate';
import type { SelectionResult } from '#internal/contracts/selection';
import { ContractError } from '#internal/errors';
import { requireKeys, requireObject, requireString } from './fields.js';
import type { FieldContext } from './fields.js';
import { parseJsonValue } from './json.js';

const context: FieldContext = {
  code: 'INVALID_SELECTION',
  stage: 'selection',
};

/** Bind a selector response to the exact candidate set it received.
 * @param input - Untrusted selector output.
 * @param set - The accepted candidate set for this decision.
 * @returns A detached, frozen selected or abstain result.
 * @throws ContractError for malformed, contradictory or out-of-set responses.
 */
export function parseSelection(
  input: unknown,
  set: CandidateSet,
): SelectionResult {
  const object = requireObject(
    parseJsonValue(input, context.stage),
    context,
    '',
  );
  const outcome = object.outcome;
  if (outcome !== 'selected' && outcome !== 'abstain') {
    throw new ContractError(
      context.code,
      context.stage,
      '/outcome',
      'invalid_outcome',
    );
  }
  requireKeys(
    object,
    outcome === 'selected'
      ? ['decisionId', 'candidateSetId', 'outcome', 'candidateId']
      : ['decisionId', 'candidateSetId', 'outcome', 'reason'],
    context,
    '',
  );
  const candidateSetId = requireString(
    object.candidateSetId,
    context,
    '/candidateSetId',
  );
  if (candidateSetId !== set.id) {
    throw new ContractError(
      context.code,
      context.stage,
      '/candidateSetId',
      'candidate_set_mismatch',
    );
  }
  const decisionId = requireString(object.decisionId, context, '/decisionId');
  if (outcome === 'abstain') {
    return Object.freeze({
      decisionId,
      candidateSetId,
      outcome,
      reason: requireString(object.reason, context, '/reason'),
    });
  }
  const candidateId = requireString(
    object.candidateId,
    context,
    '/candidateId',
  );
  if (!set.candidates.some((candidate) => candidate.id === candidateId)) {
    throw new ContractError(
      context.code,
      context.stage,
      '/candidateId',
      'unknown_candidate',
    );
  }
  return Object.freeze({ decisionId, candidateSetId, outcome, candidateId });
}
