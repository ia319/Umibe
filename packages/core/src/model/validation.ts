import type { ModelIdentity, ModelResponseMetadata } from './metadata.js';
import {
  requireInteger,
  requireKeys,
  requireObject,
  requireString,
} from '#internal/validation/fields';
import { parseJsonValue } from '#internal/validation/json';

const context = {
  code: 'INVALID_RUN_CONTROL',
  stage: 'model_metadata',
} as const;

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
