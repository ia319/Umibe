import { ActionRegistry } from '#internal/action/registry';
import type {
  CandidateRequest,
  OperationBindingRequest,
} from '#internal/contracts/adapters';
import type { CandidateGenerationInput } from '#internal/contracts/candidate-processing';
import type {
  CandidateSet,
  ParameterSource,
} from '#internal/contracts/candidate';
import type {
  OperationAvailability,
  OperationOffer,
  OperationSet,
} from '#internal/contracts/operation';
import type { JsonValue } from '#internal/contracts/json';
import { ContractError } from '#internal/errors';
import {
  requireInteger,
  requireKeys,
  requireObject,
  requireString,
} from '#internal/validation/fields';
import {
  isJsonArray,
  jsonPointerChild,
  parseJsonValue,
} from '#internal/validation/json';
import { parseCandidateSet } from '#internal/validation/candidate';
import {
  captureCandidateRequest,
  captureDecisionRequest,
  validateCandidateBasis,
} from './context.js';

const validation = { code: 'INVALID_OPERATIONS', stage: 'operations' } as const;

/** Operation discovery is available before the first accepted plan. */
export function createOperationRequest(
  input: CandidateGenerationInput,
  registry: ActionRegistry,
): CandidateRequest {
  return Object.freeze({
    ...captureDecisionRequest(input),
    capabilities: registry.capabilities,
  });
}

function readStrings(
  value: JsonValue | undefined,
  path: string,
): readonly string[] {
  if (!isJsonArray(value))
    throw new ContractError(
      validation.code,
      validation.stage,
      path,
      'expected_array',
    );
  return Object.freeze(
    value.map((item, index) =>
      requireString(item, validation, `${path}/${index}`),
    ),
  );
}

/** Capture every offer and reject unknown actions, versions and duplicate operation IDs. */
export function parseOperationSet(
  input: unknown,
  request: CandidateRequest,
): OperationSet {
  const value = requireObject(
    parseJsonValue(input, validation.stage),
    validation,
    '',
  );
  requireKeys(
    value,
    ['id', 'requestId', 'operations', 'informationGaps', 'capabilityGaps'],
    validation,
    '',
  );
  const requestId = requireString(value.requestId, validation, '/requestId');
  if (requestId !== request.requestId)
    throw new ContractError(
      validation.code,
      validation.stage,
      '/requestId',
      'request_id_mismatch',
    );
  if (!isJsonArray(value.operations))
    throw new ContractError(
      validation.code,
      validation.stage,
      '/operations',
      'expected_array',
    );
  const seen = new Set<string>();
  const capabilities = new Map(
    request.capabilities.map((capability) => [capability.id, capability]),
  );
  const operations: OperationOffer[] = value.operations.map((raw, index) => {
    const path = `/operations/${index}`;
    const offer = requireObject(raw, validation, path);
    requireKeys(
      offer,
      [
        'operationId',
        'actionVersion',
        'availability',
        'parameterSources',
        'informationGaps',
      ],
      validation,
      path,
    );
    const operationId = requireString(
      offer.operationId,
      validation,
      `${path}/operationId`,
    );
    if (seen.has(operationId))
      throw new ContractError(
        validation.code,
        validation.stage,
        `${path}/operationId`,
        'duplicate_operation_id',
      );
    seen.add(operationId);
    const capability = capabilities.get(operationId);
    if (capability === undefined)
      throw new ContractError(
        validation.code,
        validation.stage,
        `${path}/operationId`,
        'unknown_action',
      );
    const actionVersion = requireInteger(
      offer.actionVersion,
      1,
      validation,
      `${path}/actionVersion`,
    );
    if (actionVersion !== capability.version)
      throw new ContractError(
        validation.code,
        validation.stage,
        `${path}/actionVersion`,
        'action_version_mismatch',
      );
    const rawAvailability = requireObject(
      offer.availability,
      validation,
      `${path}/availability`,
    );
    const status = rawAvailability.status;
    let availability: OperationAvailability;
    if (status === 'available') {
      requireKeys(
        rawAvailability,
        ['status'],
        validation,
        `${path}/availability`,
      );
      availability = Object.freeze({ status });
    } else if (status === 'unavailable' || status === 'unknown') {
      requireKeys(
        rawAvailability,
        ['status', 'reason'],
        validation,
        `${path}/availability`,
      );
      availability = Object.freeze({
        status,
        reason: requireString(
          rawAvailability.reason,
          validation,
          `${path}/availability/reason`,
        ),
      });
    } else {
      throw new ContractError(
        validation.code,
        validation.stage,
        `${path}/availability/status`,
        'invalid_availability',
      );
    }
    const rawSources = requireObject(
      offer.parameterSources,
      validation,
      `${path}/parameterSources`,
    );
    const parameterSources: Record<string, ParameterSource> = Object.create(
      null,
    ) as Record<string, ParameterSource>;
    for (const [name, rawSource] of Object.entries(rawSources)) {
      const sourcePath = jsonPointerChild(`${path}/parameterSources`, name);
      const source = requireObject(rawSource, validation, sourcePath);
      requireKeys(source, ['kind', 'reference'], validation, sourcePath);
      const kind = source.kind;
      if (
        kind !== 'observation' &&
        kind !== 'application' &&
        kind !== 'model' &&
        kind !== 'default'
      )
        throw new ContractError(
          validation.code,
          validation.stage,
          `${sourcePath}/kind`,
          'invalid_parameter_source',
        );
      parameterSources[name] = Object.freeze({
        kind,
        reference: requireString(
          source.reference,
          validation,
          `${sourcePath}/reference`,
        ),
      });
    }
    return Object.freeze({
      operationId,
      actionVersion,
      availability,
      parameterSources: Object.freeze(parameterSources),
      informationGaps: readStrings(
        offer.informationGaps,
        `${path}/informationGaps`,
      ),
    });
  });
  return Object.freeze({
    id: requireString(value.id, validation, '/id'),
    requestId,
    operations: Object.freeze(operations),
    informationGaps: readStrings(value.informationGaps, '/informationGaps'),
    capabilityGaps: readStrings(value.capabilityGaps, '/capabilityGaps'),
  });
}

/** Bind an offered operation to a fresh accepted-plan context after any required stop. */
export function createOperationBindingRequest(
  input: CandidateGenerationInput,
  registry: ActionRegistry,
  set: OperationSet,
  operationId: string,
): OperationBindingRequest {
  const request = captureCandidateRequest(input, registry.capabilities);
  const captured = parseOperationSet(set, {
    ...request,
    requestId: set.requestId,
  });
  const operation = captured.operations.find(
    (offer) => offer.operationId === operationId,
  );
  if (operation === undefined)
    throw new ContractError(
      validation.code,
      validation.stage,
      '/operationId',
      'operation_not_offered',
    );
  if (operation.availability.status !== 'available')
    throw new ContractError(
      validation.code,
      validation.stage,
      '/operationId',
      'operation_unavailable',
    );
  return Object.freeze({ ...request, operationSetId: captured.id, operation });
}

/** Reject the whole binding if any call changes the selected operation or its current basis. */
export function parseBoundCandidates(
  input: unknown,
  request: OperationBindingRequest,
): CandidateSet {
  const set = parseCandidateSet(input);
  validateCandidateBasis(set, request);
  for (const [index, candidate] of set.candidates.entries()) {
    if (candidate.actionId !== request.operation.operationId)
      throw new ContractError(
        'INVALID_CANDIDATES',
        'operation_binding',
        `/candidates/${index}/actionId`,
        'operation_mismatch',
      );
    if (candidate.actionVersion !== request.operation.actionVersion)
      throw new ContractError(
        'INVALID_CANDIDATES',
        'operation_binding',
        `/candidates/${index}/actionVersion`,
        'action_version_mismatch',
      );
  }
  return set;
}
