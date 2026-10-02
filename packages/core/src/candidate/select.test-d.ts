import { assertType } from 'vitest';
import type { CallControl, Selector } from '#internal/contracts/adapters';
import type {
  CandidateSelectionResult,
  FilteredCandidates,
} from '#internal/contracts/candidate-processing';
import { selectCandidates } from './select.js';

declare const filtered: FilteredCandidates;
declare const selector: Selector;
declare const control: CallControl;
assertType<Promise<CandidateSelectionResult>>(
  selectCandidates(filtered, selector, control, 10),
);
// @ts-expect-error Selection requires a batch that passed the filtering boundary.
void selectCandidates(filtered.checked, selector, control);
declare const result: CandidateSelectionResult;
if (result.outcome === 'selected') {
  assertType<string>(result.candidate.actionId);
  // @ts-expect-error Selected calls retain immutable parameter data.
  result.candidate.params.target = 'replacement';
  // @ts-expect-error Selection grants no action execution method.
  void result.execute;
} else {
  // @ts-expect-error No call is selected when selection abstains, stops or fails.
  void result.candidate;
}
