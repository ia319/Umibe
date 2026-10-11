import type {
  SingleCallSelector,
  ResumableSelector,
  Selector,
  SelectorRequest,
  SelectionResult,
} from './contracts.js';
import type {
  StructuredOutputModel,
  ChoiceModel,
  ChoiceResponse,
  StructuredOutputRequest,
} from '#internal/model/contracts';
import type { JsonValue } from '#internal/contracts/json';
import type { CallControl } from '#internal/contracts/control';
import { captureModelIdentity } from '#internal/model/validation';
import {
  captureDecisionRequest,
  validateCandidateBasis,
} from '#internal/candidate/context';
import { captureControl } from '#internal/candidate/control';
import { ContractError } from '#internal/errors';
import {
  requireInteger,
  requireKeys,
  requireObject,
  requireString,
  requireTimestamp,
} from '#internal/validation/fields';
import { parseJsonValue } from '#internal/validation/json';
import { parseCandidateSet } from '#internal/validation/candidate';
import { modelOutputError } from '#internal/model/output-error';
import { ModelRequestError } from '#internal/runtime/model';
import { projectSelectionInput } from '#internal/model/projection';
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
  /**
   * Compare all candidates in provider-sized batches, then compare their chosen
   * winners until one remains. Every batch includes abstention. This tournament
   * is order-sensitive and does not reproduce an unlimited joint distribution.
   * Returns a resumable selector; Agent owns the tournament and yields between
   * batches. Requires a choice model with maxOptions >= 3. Capacity limits the
   * complete candidate set before any batch starts.
   */
  readonly overflow?: 'reject' | 'compareBatches';
}

/**
 * Create a stateless selector. Each nonempty select or advance requests once; Agent owns budgets.
 * Direct empty calls return abstain/no_candidates. Excess capacity rejects with
 * ContractError reason candidate_limit before model access. No candidate is truncated.
 */
export function createSelector(
  options: SelectorOptions & { readonly overflow: 'compareBatches' },
): ResumableSelector;
export function createSelector(
  options: SelectorOptions & { readonly overflow?: 'reject' },
): SingleCallSelector;
export function createSelector(options: SelectorOptions): Selector;
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
  if (
    options.overflow !== undefined &&
    options.overflow !== 'reject' &&
    options.overflow !== 'compareBatches'
  )
    throw new ContractError(
      validation.code,
      validation.stage,
      '/overflow',
      'invalid_overflow',
    );
  const compareBatches = options.overflow === 'compareBatches';
  if (
    compareBatches &&
    (configured.kind !== 'choice' ||
      configured.maxOptions === undefined ||
      configured.maxOptions < 3)
  )
    throw new ContractError(
      validation.code,
      validation.stage,
      '/model/maxOptions',
      'batching_requires_at_least_three_options',
    );
  let batchCapacity: number | undefined;
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
    if (compareBatches) batchCapacity = maximum - 1;
    else capacity = Math.min(capacity ?? Number.MAX_SAFE_INTEGER, maximum - 1);
  }
  const compare = async (
    input: SelectorRequest,
    controlInput: CallControl,
  ): Promise<SelectionResult> => {
    let control = captureControl(controlInput);
    if (control.signal.aborted)
      throw new DOMException('Model request cancelled', 'AbortError');
    if (Date.now() >= control.deadlineMs)
      throw new ModelRequestError('deadline_exceeded');
    const source = requireObject(
      parseJsonValue(input, 'selector_request'),
      validation,
      '',
    );
    const request: SelectorRequest = Object.freeze({
      ...captureDecisionRequest({
        requestId: source.requestId,
        decisionEpoch: source.decisionEpoch,
        context: source.context,
      }),
      candidates: parseCandidateSet(source.candidates),
    });
    validateCandidateBasis(request.candidates, request);
    if (batchCapacity !== undefined) {
      requireKeys(
        source,
        [
          'requestId',
          'decisionEpoch',
          'context',
          'candidates',
          'selectionId',
          'operationSetId',
          'operationId',
          'sourceCandidateSetId',
          'deadlineAt',
          'round',
          'batchIndex',
        ],
        validation,
        '',
      );
      requireString(source.selectionId, validation, '/selectionId');
      requireString(source.operationSetId, validation, '/operationSetId');
      const operationId = requireString(
        source.operationId,
        validation,
        '/operationId',
      );
      requireString(
        source.sourceCandidateSetId,
        validation,
        '/sourceCandidateSetId',
      );
      requireInteger(source.round, 0, validation, '/round');
      requireInteger(source.batchIndex, 0, validation, '/batchIndex');
      const deadlineAt = requireTimestamp(
        source.deadlineAt,
        validation,
        '/deadlineAt',
      );
      if (
        request.candidates.candidates.some(
          (candidate) => candidate.actionId !== operationId,
        )
      )
        throw new ContractError(
          validation.code,
          validation.stage,
          '/operationId',
          'operation_mismatch',
        );
      if (Date.parse(deadlineAt) < control.deadlineMs)
        control = captureControl({ ...control, deadlineAt });
      if (Date.now() >= control.deadlineMs)
        throw new ModelRequestError('deadline_exceeded');
    }
    const count = request.candidates.candidates.length;
    if (count === 0)
      return Object.freeze({
        outcome: 'abstain',
        decisionId: request.requestId,
        candidateSetId: request.candidates.id,
        reason: 'no_candidates',
      });
    const requestCapacity =
      batchCapacity === undefined
        ? capacity
        : capacity === undefined
          ? batchCapacity
          : Math.min(batchCapacity, capacity);
    if (requestCapacity !== undefined && count > requestCapacity)
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
      if (control.recordModelProjection !== undefined) {
        await control.recordModelProjection({
          role: 'selection',
          version: 1,
          source:
            batchCapacity === undefined
              ? parseJsonValue(request, 'selector_request')
              : source,
          request: parseJsonValue(formatted.request, 'selector_request'),
        });
        if (control.signal.aborted)
          throw new DOMException('Model request cancelled', 'AbortError');
        if (Date.now() >= control.deadlineMs)
          throw new ModelRequestError('deadline_exceeded');
      }
      output = {
        kind: 'choice',
        value: await model.choose(formatted.request, control),
        abstainId: formatted.abstainId,
      };
    } else {
      const modelRequest: StructuredOutputRequest = Object.freeze({
        instructions: selectorInstructions,
        input: parseJsonValue(
          projectSelectionInput(request),
          'selector_request',
        ),
        output: Object.freeze({
          name: 'umibe_selection',
          schema: selectorOutputSchema,
        }),
      });
      if (control.recordModelProjection !== undefined) {
        await control.recordModelProjection({
          role: 'selection',
          version: 1,
          source: parseJsonValue(request, 'selector_request'),
          request: parseJsonValue(modelRequest, 'selector_request'),
        });
        if (control.signal.aborted)
          throw new DOMException('Model request cancelled', 'AbortError');
        if (Date.now() >= control.deadlineMs)
          throw new ModelRequestError('deadline_exceeded');
      }
      output = {
        kind: 'structuredOutput',
        value: await model.generate(modelRequest, control),
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
  };
  const declaration = {
    model: identity,
    ...(capacity === undefined ? {} : { capacity }),
  };
  return batchCapacity === undefined
    ? Object.freeze<SingleCallSelector>({
        ...declaration,
        kind: 'single',
        select: compare,
      })
    : Object.freeze<ResumableSelector>({
        ...declaration,
        kind: 'resumable',
        batchCapacity,
        advance: compare,
      });
}
