import { assertType } from 'vitest';
import type { CallControl } from '#internal/contracts/control';
import type { CandidateSet } from '#internal/contracts/candidate';
import type {
  CandidateCheckingResult,
  PreparedCandidates,
} from '#internal/contracts/candidate-processing';
import { checkCandidates } from './check.js';

declare const prepared: PreparedCandidates;
declare const control: CallControl;
assertType<Promise<CandidateCheckingResult>>(
  checkCandidates(prepared, control),
);
declare const rawSet: CandidateSet;
// @ts-expect-error A parsed candidate set does not carry the private preparation binding.
void checkCandidates(rawSet, control);
declare const result: CandidateCheckingResult;
if (result.outcome === 'checked') {
  assertType<CandidateSet>(result.checked.set);
  // @ts-expect-error Successful checks do not grant dispatch authority.
  void result.checked.execute;
} else {
  // @ts-expect-error Partial results expose diagnostics without an allowed set.
  void result.checked;
}
