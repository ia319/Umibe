import type { Selector, SelectorRequest } from './contracts.js';
import type {
  StructuredOutputModel,
  ChoiceModel,
  ChoiceResponse,
} from '#internal/model/contracts';
import type { JsonValue } from '#internal/contracts/json';
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
import { decodeChoiceSelection, formatChoiceSelection } from './choice.js';

export interface SelectorOptions {
  readonly model: StructuredOutputModel | ChoiceModel;
  /** Positive safe integer limiting action candidates; omitted means no declared count limit. */
  readonly capacity?: number;
}

/**
 * Create a stateless selector. Nonempty calls request once; Agent owns budgets.
 * Direct empty calls return abstain/no_candidates. Excess capacity rejects with
 * ContractError reason candidate_limit before model access. No candidate is truncated.
 */
export function createSelector(options: SelectorOptions): Selector {
  const configured = options.model;
  if (!(
    (configured?.kind === 'structuredOutput' &&
      typeof configured.generate === 'function') ||
    (configured?.kind === 'choice' && typeof configured.choose === 'function')
  ))
    throw new TypeError(
      'Selector requires a structured output or choice model',
    );
  const identity = captureModelIdentity(configured.identity);
  const model =
    configured.kind === 'choice'
      ? { kind: 'choice' as const, choose: configured.choose.bind(configured) }
      : {
          kind: 'structuredOutput' as const,
          generate: configured.generate.bind(configured),
        };
  let capacity = options.capacity;
  const validation = {
    code: 'INVALID_CANDIDATE_REQUEST',
    stage: 'selector',
  } as const;
  if (capacity !== undefined)
    requireInteger(capacity, 1, validation, '/capacity');
  if (configured.kind === 'choice' && configured.maxOptions !== undefined) {
    const maximum = requireInteger(
      configured.maxOptions,
      1,
      validation,
      '/model/maxOptions',
    );
    if (maximum < 2)
      throw new ContractError(
        validation.code,
        validation.stage,
        '/model/maxOptions',
        'expected_at_least_two_options',
      );
    capacity = Math.min(capacity ?? Number.MAX_SAFE_INTEGER, maximum - 1);
  }
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
      let output:
        | { kind: 'structuredOutput'; value: JsonValue }
        | { kind: 'choice'; value: ChoiceResponse; abstainId: string };
      if (model.kind === 'choice') {
        const formatted = formatChoiceSelection(request);
        output = {
          kind: 'choice',
          value: await model.choose(formatted.request, control),
          abstainId: formatted.abstainId,
        };
      } else {
        output = {
          kind: 'structuredOutput',
          value: await model.generate(
            {
              instructions: selectorInstructions,
              input: parseJsonValue({ request }, 'selector_request'),
              output: { name: 'umibe_selection', schema: selectorOutputSchema },
            },
            control,
          ),
        };
      }
      if (control.signal.aborted)
        throw new DOMException('Model request cancelled', 'AbortError');
      if (Date.now() >= control.deadlineMs)
        throw new ModelRequestError('deadline_exceeded');
      try {
        if (output.kind === 'choice') {
          const decoded = decodeChoiceSelection(
            output.value,
            request,
            output.abstainId,
          );
          control.reportModelChoice?.(decoded.metadata);
          return decoded.selection;
        }
        return decodeSelectionOutput(output.value, request);
      } catch (error) {
        throw modelOutputError('selection', error);
      }
    },
  });
}
