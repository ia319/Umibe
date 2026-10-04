import type { ChoiceRequest } from '#internal/model/contracts';
import type { SelectionResult, SelectorRequest } from './contracts.js';
import { captureModelChoice } from '#internal/model/validation';
import { ContractError } from '#internal/errors';
import { parseJsonValue } from '#internal/validation/json';
import {
  requireKeys,
  requireObject,
  requireString,
} from '#internal/validation/fields';
import { parseSelection } from './validation.js';
import { selectionContextInstructions } from './format.js';

const context = {
  code: 'INVALID_SELECTION',
  stage: 'choice_selection',
} as const;

/** Keep observed state, question references and fixed options in their respective model fields. */
export function formatChoiceSelection(request: SelectorRequest): {
  request: ChoiceRequest;
  abstainId: string;
} {
  const { observation, ...references } = request.context;
  const { candidates, ...candidateContext } = request.candidates;
  const ids = new Set(candidates.map((candidate) => candidate.id));
  let abstainId = '__umibe_abstain__';
  while (ids.has(abstainId)) abstainId += '_';
  return {
    abstainId,
    request: Object.freeze({
      instructions: Object.freeze({
        question: `${selectionContextInstructions}
Choose the explicit abstention option if no action is suitable or current evidence is insufficient. A single action can still be rejected.
Use the current observation in the input state and the complete question references below. Selection remains a recommendation subject to execution-time rechecking.`,
        references: parseJsonValue(
          {
            requestId: request.requestId,
            decisionEpoch: request.decisionEpoch,
            context: references,
            candidates: candidateContext,
          },
          context.stage,
        ),
      }),
      input: parseJsonValue(observation, context.stage),
      options: Object.freeze([
        ...candidates.map((candidate) =>
          Object.freeze({
            id: candidate.id,
            description: parseJsonValue(candidate, context.stage),
          }),
        ),
        Object.freeze({
          id: abstainId,
          description:
            'Abstain: select no action when no supplied candidate is suitable or evidence is insufficient.',
        }),
      ]),
    }),
  };
}

/** Validate model data and bind IDs to this immutable request before reporting choice evidence. */
export function decodeChoiceSelection(
  input: unknown,
  request: SelectorRequest,
  abstainId: string,
) {
  const value = requireObject(
    parseJsonValue(input, context.stage),
    context,
    '',
  );
  const hasProbabilities = Object.hasOwn(value, 'probabilities');
  const hasConfidence = Object.hasOwn(value, 'confidence');
  requireKeys(
    value,
    [
      'optionId',
      ...(hasProbabilities ? ['probabilities'] : []),
      ...(hasConfidence ? ['confidence'] : []),
    ],
    context,
    '',
  );
  const optionId = requireString(value.optionId, context, '/optionId');
  const probabilities = hasProbabilities
    ? requireObject(value.probabilities, context, '/probabilities')
    : null;
  const ids = [
    ...request.candidates.candidates.map((candidate) => candidate.id),
    abstainId,
  ];
  if (probabilities !== null)
    requireKeys(probabilities, ids, context, '/probabilities');
  if (hasConfidence && value.confidence === null)
    throw new ContractError(
      context.code,
      context.stage,
      '/confidence',
      'invalid_probability',
    );
  if (probabilities !== null && ids.some((id) => probabilities[id] === null))
    throw new ContractError(
      context.code,
      context.stage,
      '/probabilities',
      'invalid_probability',
    );
  const metadata = captureModelChoice({
    candidateSetId: request.candidates.id,
    optionId,
    options: ids.map((id) => ({
      id,
      candidateId: id === abstainId ? null : id,
      probability: probabilities === null ? null : probabilities[id],
    })),
    confidence: hasConfidence ? value.confidence : null,
  });
  const selection: SelectionResult = parseSelection(
    {
      decisionId: request.requestId,
      candidateSetId: request.candidates.id,
      ...(optionId === abstainId
        ? { outcome: 'abstain', reason: 'model_abstained' }
        : { outcome: 'selected', candidateId: optionId }),
    },
    request.candidates,
  );
  return { selection, metadata };
}
