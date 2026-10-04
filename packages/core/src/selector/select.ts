import type { CallControl } from '#internal/contracts/control';
import type {
  Selector,
  SelectorRequest,
  SelectionResult,
} from '#internal/selector/contracts';
import type {
  CandidateSelectionResult,
  FilteredCandidates,
} from '#internal/contracts/candidate-processing';
import { ContractError } from '#internal/errors';
import { requireInteger } from '#internal/validation/fields';
import { parseSelection } from '#internal/selector/validation';
import { captureControl, invokeControlled } from '#internal/candidate/control';
import {
  candidateContractIssue,
  invocationFailure,
} from '#internal/candidate/diagnostics';
import {
  assertFilteredCandidates,
  registerSelectedCandidate,
} from '#internal/candidate/handles';

/**
 * Select from an accepted filtered batch, including when it has just one member.
 * Capacity is an optional positive safe integer; exceeding it returns
 * candidate_limit without truncation or a selector call. Empty batches return
 * no_candidates. Invalid arguments reject with ContractError; adapter failures
 * return stage diagnostics. A selected result grants no execution authority.
 */
export async function selectCandidates(
  filtered: FilteredCandidates,
  selector: Selector,
  controlInput: CallControl,
  capacity?: number,
): Promise<CandidateSelectionResult> {
  assertFilteredCandidates(filtered);
  if (
    typeof selector !== 'object' ||
    selector === null ||
    typeof selector.select !== 'function'
  ) {
    throw new ContractError(
      'INVALID_CANDIDATE_REQUEST',
      'candidate_selection',
      '/selector',
      'expected_selector',
    );
  }
  const select = selector.select.bind(selector);
  const control = captureControl(controlInput);
  if (capacity !== undefined) {
    requireInteger(
      capacity,
      1,
      { code: 'INVALID_CANDIDATE_REQUEST', stage: 'candidate_selection' },
      '/capacity',
    );
  }
  const stopped = control.signal.aborted
    ? 'cancelled'
    : Date.now() >= control.deadlineMs
      ? 'deadlineExceeded'
      : null;
  if (stopped !== null)
    return Object.freeze({
      ...invocationFailure({ outcome: stopped }, 'selection', null),
      filtered,
    });

  const count = filtered.set.candidates.length;
  if (count === 0) return Object.freeze({ outcome: 'no_candidates', filtered });
  if (capacity !== undefined && count > capacity) {
    return Object.freeze({
      outcome: 'candidate_limit',
      filtered,
      count,
      capacity,
    });
  }
  const source = filtered.checked.prepared.request;
  const request: SelectorRequest = Object.freeze({
    requestId: source.requestId,
    decisionEpoch: source.decisionEpoch,
    context: source.context,
    candidates: filtered.set,
  });
  const result = await invokeControlled<unknown>(control, (control) =>
    select(request, control),
  );
  if (result.outcome !== 'returned') {
    return Object.freeze({
      ...invocationFailure(result, 'selection', null),
      filtered,
    });
  }
  let selection: SelectionResult;
  try {
    selection = parseSelection(result.value, filtered.set);
  } catch (error) {
    return Object.freeze({
      outcome: 'failed',
      stage: 'selection',
      candidateId: null,
      reason: 'invalid_result',
      issue: candidateContractIssue(error),
      filtered,
    });
  }
  const accepted: CandidateSelectionResult =
    selection.outcome === 'selected'
      ? Object.freeze({
          outcome: 'selected',
          filtered,
          selection,
          candidate: filtered.set.candidates.find(
            (candidate) => candidate.id === selection.candidateId,
          )!,
        })
      : Object.freeze({ outcome: 'abstain', filtered, selection });
  const late = control.signal.aborted
    ? 'cancelled'
    : Date.now() >= control.deadlineMs
      ? 'deadlineExceeded'
      : null;
  if (late !== null)
    return Object.freeze({
      ...invocationFailure({ outcome: late }, 'selection', null),
      filtered,
    });
  return accepted.outcome === 'selected'
    ? registerSelectedCandidate(accepted)
    : accepted;
}
