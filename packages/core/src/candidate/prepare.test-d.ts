import { assertType } from 'vitest';
import type { ActionRegistry } from '#internal/action/registry';
import type {
  CallControl,
  CandidateProvider,
} from '#internal/contracts/adapters';
import type { CandidateSet } from '#internal/contracts/candidate';
import type {
  CandidateGenerationInput,
  CandidatePreparationResult,
} from '#internal/contracts/candidate-processing';
import { prepareCandidates } from './prepare.js';

declare const input: CandidateGenerationInput;
declare const registry: ActionRegistry;
declare const provider: CandidateProvider;
declare const control: CallControl;
assertType<Promise<CandidatePreparationResult>>(
  prepareCandidates(input, registry, provider, control),
);
declare const result: CandidatePreparationResult;
if (result.outcome === 'prepared') {
  assertType<CandidateSet>(result.prepared.set);
  // @ts-expect-error A preparation token does not expose action dispatch.
  void result.prepared.execute;
  // @ts-expect-error Captured constraints are immutable JSON data.
  result.prepared.request.context.effectiveConstraints.limit = 99;
} else {
  // @ts-expect-error A failed preparation exposes diagnostics, not an eligible set.
  void result.prepared;
}
