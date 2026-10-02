import { assertType } from 'vitest';
import type {
  CallControl,
  CandidateFilter,
} from '#internal/contracts/adapters';
import type {
  CandidateFilteringResult,
  CheckedCandidates,
} from '#internal/contracts/candidate-processing';
import { filterCandidates } from './filter.js';

declare const checked: CheckedCandidates;
declare const control: CallControl;
declare const filter: CandidateFilter;
assertType<Promise<CandidateFilteringResult>>(
  filterCandidates(checked, control, filter),
);
// @ts-expect-error A prepared batch has not passed the core's dynamic checks.
void filterCandidates(checked.prepared, control);
declare const result: CandidateFilteringResult;
if (result.outcome !== 'filtered') {
  // @ts-expect-error An invalid filter response exposes no accepted subset.
  void result.filtered;
}
