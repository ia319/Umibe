import { assertType } from 'vitest';
import type { ActionRegistry } from '#internal/action/registry';
import type { CallControl } from '#internal/contracts/adapters';
import type {
  CandidateRecheckInput,
  CandidateRecheckResult,
  CandidateSelectionResult,
  SelectedCandidate,
} from '#internal/contracts/candidate-processing';
import { recheckCandidate } from './recheck.js';

declare const selected: SelectedCandidate;
declare const current: CandidateRecheckInput;
declare const registry: ActionRegistry;
declare const control: CallControl;
assertType<Promise<CandidateRecheckResult>>(
  recheckCandidate(selected, current, registry, control),
);
declare const selection: CandidateSelectionResult;
if (selection.outcome !== 'selected') {
  // @ts-expect-error Only an accepted selected result can enter rechecking.
  void recheckCandidate(selection, current, registry, control);
}
declare const result: CandidateRecheckResult;
if (result.outcome === 'rechecked') {
  assertType<'allowed' | 'denied' | 'unknown'>(result.check.outcome);
  // @ts-expect-error Rechecking retains the immutable fixed call.
  result.selected.candidate.params.target = 'replacement';
} else {
  // @ts-expect-error Failed or invalidated rechecks expose no accepted business result.
  void result.check;
}
// @ts-expect-error Recheck results never expose action dispatch.
void result.execute;
