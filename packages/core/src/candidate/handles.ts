import type { PreparedAction } from '#internal/contracts/action';
import type {
  CheckedCandidates,
  FilteredCandidates,
  PreparedCandidates,
  SelectedCandidate,
} from '#internal/contracts/candidate-processing';
import { ContractError } from '#internal/errors';

const preparedCalls = new WeakMap<
  PreparedCandidates,
  ReadonlyMap<string, PreparedAction>
>();

const checkedCandidates = new WeakSet<CheckedCandidates>();
const filteredCandidates = new WeakSet<FilteredCandidates>();
const selectedCalls = new WeakMap<SelectedCandidate, PreparedAction>();

export function registerSelectedCandidate(
  data: SelectedCandidate,
): SelectedCandidate {
  const token = Object.freeze(data);
  const calls = getPreparedCalls(data.filtered.checked.prepared);
  selectedCalls.set(token, calls.get(data.candidate.id)!);
  return token;
}

export function getSelectedCall(selected: SelectedCandidate): PreparedAction {
  const call = selectedCalls.get(selected);
  if (call === undefined) {
    throw new ContractError(
      'INVALID_CANDIDATE_REQUEST',
      'candidate_rechecking',
      '',
      'unselected_candidate',
    );
  }
  return call;
}

export function registerFilteredCandidates(
  data: FilteredCandidates,
): FilteredCandidates {
  const token = Object.freeze(data);
  filteredCandidates.add(token);
  return token;
}

export function assertFilteredCandidates(filtered: FilteredCandidates): void {
  if (!filteredCandidates.has(filtered)) {
    throw new ContractError(
      'INVALID_CANDIDATE_REQUEST',
      'candidate_selection',
      '',
      'unfiltered_candidates',
    );
  }
}

export function registerCheckedCandidates(
  data: CheckedCandidates,
): CheckedCandidates {
  const token = Object.freeze(data);
  checkedCandidates.add(token);
  return token;
}

export function assertCheckedCandidates(checked: CheckedCandidates): void {
  if (!checkedCandidates.has(checked)) {
    throw new ContractError(
      'INVALID_CANDIDATE_REQUEST',
      'candidate_filtering',
      '',
      'unchecked_candidates',
    );
  }
}

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
