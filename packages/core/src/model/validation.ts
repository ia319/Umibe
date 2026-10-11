import type {
  ModelIdentity,
  ModelResponseMetadata,
  ModelChoiceMetadata,
  ModelResponseIssue,
  ModelRequestRecord,
  ModelResponseRecord,
  ModelProjectionRecord,
} from './metadata.js';
import type { JsonValue } from '#internal/contracts/json';
import { ContractError } from '#internal/errors';
import {
  requireInteger,
  requireKeys,
  requireObject,
  requireString,
} from '#internal/validation/fields';
import { isJsonArray, parseJsonValue } from '#internal/validation/json';

const context = {
  code: 'INVALID_RUN_CONTROL',
  stage: 'model_metadata',
} as const;

/** Capture bounded contract diagnostics without rejected values or exception messages. */
export function captureModelIssue(
  phase: ModelResponseIssue['phase'],
  error: unknown,
): ModelResponseIssue {
  return Object.freeze({
    phase,
    path:
      error instanceof ContractError &&
      error.path.length <= 256 &&
      /^(?:\/[A-Za-z0-9_-]+)*$/.test(error.path)
        ? error.path
        : '',
    reason:
      error instanceof ContractError &&
      /^[a-z][a-z0-9_]{0,63}$/.test(error.reason)
        ? error.reason
        : 'invalid_output',
  });
}

export function captureModelIdentity(input: ModelIdentity): ModelIdentity {
  const value = requireObject(
    parseJsonValue(input, context.stage),
    context,
    '',
  );
  requireKeys(value, ['provider', 'model'], context, '');
  return Object.freeze({
    provider: requireString(value.provider, context, '/provider'),
    model: requireString(value.model, context, '/model'),
  });
}

/** Capture an exact transport body without parsing, normalizing, or truncating it. */
export function captureModelRequestRecord(input: unknown): ModelRequestRecord {
  const value = requireObject(
    parseJsonValue(input, context.stage),
    context,
    '',
  );
  requireKeys(value, ['protocol', 'method', 'body'], context, '');
  if (value.protocol !== 'http' && value.protocol !== 'jsonRpc')
    throw new ContractError(
      context.code,
      context.stage,
      '/protocol',
      'invalid_protocol',
    );
  if (typeof value.body !== 'string')
    throw new ContractError(
      context.code,
      context.stage,
      '/body',
      'expected_string',
    );
  return Object.freeze({
    protocol: value.protocol,
    method: requireString(value.method, context, '/method'),
    body: value.body,
  });
}

export function captureModelProjectionRecord(
  input: unknown,
): ModelProjectionRecord {
  const value = requireObject(
    parseJsonValue(input, context.stage),
    context,
    '',
  );
  requireKeys(value, ['role', 'version', 'source', 'request'], context, '');
  if (
    value.role !== 'planning' &&
    value.role !== 'selection' &&
    value.role !== 'decision'
  )
    throw new ContractError(
      context.code,
      context.stage,
      '/role',
      'invalid_projection_role',
    );
  if (value.version !== 1)
    throw new ContractError(
      context.code,
      context.stage,
      '/version',
      'unsupported_projection_version',
    );
  return Object.freeze({
    role: value.role,
    version: value.version,
    source: value.source!,
    request: value.request!,
  });
}

export function captureModelResultRecord(input: unknown): ModelResponseRecord {
  const value = requireObject(
    parseJsonValue(input, context.stage),
    context,
    '',
  );
  requireKeys(
    value,
    ['protocol', 'method', 'body', 'status', 'encoding', 'complete'],
    context,
    '',
  );
  const { status, encoding, complete, ...body } = value;
  const request = captureModelRequestRecord(body);
  if (encoding !== 'utf8' && encoding !== 'base64')
    throw new ContractError(
      context.code,
      context.stage,
      '/encoding',
      'invalid_encoding',
    );
  if (
    encoding === 'base64' &&
    Buffer.from(request.body, 'base64').toString('base64') !== request.body
  )
    throw new ContractError(
      context.code,
      context.stage,
      '/body',
      'invalid_base64',
    );
  if (typeof complete !== 'boolean')
    throw new ContractError(
      context.code,
      context.stage,
      '/complete',
      'expected_boolean',
    );
  return Object.freeze({
    ...request,
    encoding,
    complete,
    status:
      status === null ? null : requireInteger(status, 0, context, '/status'),
  });
}

export function captureModelResponse(
  input: ModelResponseMetadata,
): ModelResponseMetadata {
  const value = requireObject(
    parseJsonValue(input, context.stage),
    context,
    '',
  );
  requireKeys(value, ['model', 'requestId', 'usage'], context, '');
  const usage =
    value.usage === null ? null : requireObject(value.usage, context, '/usage');
  if (usage !== null)
    requireKeys(
      usage,
      ['inputTokens', 'outputTokens', 'totalTokens'],
      context,
      '/usage',
    );
  return Object.freeze({
    model:
      value.model === null
        ? null
        : requireString(value.model, context, '/model'),
    requestId:
      value.requestId === null
        ? null
        : requireString(value.requestId, context, '/requestId'),
    usage:
      usage === null
        ? null
        : Object.freeze({
            inputTokens:
              usage.inputTokens === null
                ? null
                : requireInteger(
                    usage.inputTokens,
                    0,
                    context,
                    '/usage/inputTokens',
                  ),
            outputTokens:
              usage.outputTokens === null
                ? null
                : requireInteger(
                    usage.outputTokens,
                    0,
                    context,
                    '/usage/outputTokens',
                  ),
            totalTokens:
              usage.totalTokens === null
                ? null
                : requireInteger(
                    usage.totalTokens,
                    0,
                    context,
                    '/usage/totalTokens',
                  ),
          }),
  });
}

function captureProbability(
  value: JsonValue | undefined,
  path: string,
): number | null {
  if (value === null) return null;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  )
    throw new ContractError(
      context.code,
      context.stage,
      path,
      'invalid_probability',
    );
  return value;
}

export function captureModelChoice(input: unknown): ModelChoiceMetadata {
  const value = requireObject(
    parseJsonValue(input, context.stage),
    context,
    '',
  );
  requireKeys(
    value,
    ['candidateSetId', 'optionId', 'options', 'confidence'],
    context,
    '',
  );
  if (!isJsonArray(value.options) || value.options.length < 2)
    throw new ContractError(
      context.code,
      context.stage,
      '/options',
      'expected_choice_options',
    );
  const ids = new Set<string>();
  const candidates = new Set<string | null>();
  const options = value.options.map((item, index) => {
    const path = `/options/${index}`;
    const option = requireObject(item, context, path);
    requireKeys(option, ['id', 'candidateId', 'probability'], context, path);
    const id = requireString(option.id, context, `${path}/id`);
    const candidateId =
      option.candidateId === null
        ? null
        : requireString(option.candidateId, context, `${path}/candidateId`);
    if (ids.has(id) || candidates.has(candidateId))
      throw new ContractError(
        context.code,
        context.stage,
        path,
        'duplicate_choice_option',
      );
    ids.add(id);
    candidates.add(candidateId);
    return Object.freeze({
      id,
      candidateId,
      probability: captureProbability(
        option.probability,
        `${path}/probability`,
      ),
    });
  });
  const optionId = requireString(value.optionId, context, '/optionId');
  if (!ids.has(optionId) || !candidates.has(null))
    throw new ContractError(
      context.code,
      context.stage,
      '/optionId',
      'invalid_choice_mapping',
    );
  return Object.freeze({
    candidateSetId: requireString(
      value.candidateSetId,
      context,
      '/candidateSetId',
    ),
    optionId,
    options: Object.freeze(options),
    confidence: captureProbability(value.confidence, '/confidence'),
  });
}
