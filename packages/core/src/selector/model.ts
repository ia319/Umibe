import type { Selector, SelectorRequest } from './contracts.js';
import type { StructuredOutputModel } from '#internal/model/contracts';
import { captureModelIdentity } from '#internal/model/validation';
import {
  captureDecisionRequest,
  validateCandidateBasis,
} from '#internal/candidate/context';
import { captureControl } from '#internal/candidate/control';
import { ContractError } from '#internal/errors';
import { requireInteger } from '#internal/validation/fields';
import { parseJsonValue } from '#internal/validation/json';
import { parseCandidateSet } from '#internal/validation/candidate';
import { modelOutputError } from '#internal/model/output-error';
import { ModelRequestError } from '#internal/runtime/model';
import {
  decodeSelectionOutput,
  selectorInstructions,
  selectorOutputSchema,
} from './format.js';

export interface SelectorOptions {
  readonly model: StructuredOutputModel;
  /** Positive safe integer limiting action candidates; omitted means no declared count limit. */
  readonly capacity?: number;
}

/**
 * Create a stateless selector. Nonempty calls generate once; Agent owns budgets.
 * Direct empty calls return abstain/no_candidates. Excess capacity rejects with
 * ContractError reason candidate_limit before model access. No candidate is truncated.
 */
export function createSelector(options: SelectorOptions): Selector {
  if (
    options.model?.kind !== 'structuredOutput' ||
    typeof options.model.generate !== 'function'
  )
    throw new TypeError('Selector requires a structured output model');
  const identity = captureModelIdentity(options.model.identity);
  const generate = options.model.generate.bind(options.model);
  const capacity = options.capacity;
  if (capacity !== undefined)
    requireInteger(
      capacity,
      1,
      { code: 'INVALID_CANDIDATE_REQUEST', stage: 'selector' },
      '/capacity',
    );
  return Object.freeze<Selector>({
    model: identity,
    ...(capacity === undefined ? {} : { capacity }),
    async select(input, controlInput) {
      const control = captureControl(controlInput);
      if (control.signal.aborted)
        throw new DOMException('Model request cancelled', 'AbortError');
      if (Date.now() >= control.deadlineMs)
        throw new ModelRequestError('deadline_exceeded');
      const request: SelectorRequest = Object.freeze({
        ...captureDecisionRequest({
          requestId: input.requestId,
          decisionEpoch: input.decisionEpoch,
          context: input.context,
        }),
        candidates: parseCandidateSet(input.candidates),
      });
      validateCandidateBasis(request.candidates, request);
      const count = request.candidates.candidates.length;
      if (count === 0)
        return Object.freeze({
          outcome: 'abstain',
          decisionId: request.requestId,
          candidateSetId: request.candidates.id,
          reason: 'no_candidates',
        });
      if (capacity !== undefined && count > capacity)
        throw new ContractError(
          'INVALID_CANDIDATE_REQUEST',
          'selector',
          '/candidates',
          'candidate_limit',
        );
      const output = await generate(
        {
          instructions: selectorInstructions,
          input: parseJsonValue({ request }, 'selector_request'),
          output: { name: 'umibe_selection', schema: selectorOutputSchema },
        },
        control,
      );
      if (control.signal.aborted)
        throw new DOMException('Model request cancelled', 'AbortError');
      if (Date.now() >= control.deadlineMs)
        throw new ModelRequestError('deadline_exceeded');
      try {
        return decodeSelectionOutput(output, request);
      } catch (error) {
        throw modelOutputError('selection', error);
      }
    },
  });
}
