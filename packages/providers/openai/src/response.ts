import {
  isJsonObject,
  isJsonArray,
  parseJsonValue,
  ModelRequestError,
} from '@umibe/core/model';
import type {
  CallControl,
  JsonObject,
  JsonValue,
  ModelResponseMetadata,
} from '@umibe/core/model';

function object(value: JsonValue | undefined): JsonObject {
  if (!isJsonObject(value)) throw new ModelRequestError('invalid_response');
  return value;
}

export function decodeResponse(
  input: unknown,
  requestId: string | null,
  control: CallControl,
): JsonValue {
  let response: JsonObject;
  try {
    response = object(parseJsonValue(input, 'openai_response'));
  } catch {
    throw new ModelRequestError('invalid_response');
  }
  let invalidUsage = response.usage != null && !isJsonObject(response.usage);
  const usage = isJsonObject(response.usage) ? response.usage : null;
  const tokens = (value: JsonValue | undefined): number | null => {
    if (value === undefined || value === null) return null;
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 0
    ) {
      invalidUsage = true;
      return null;
    }
    return value;
  };
  const metadata: ModelResponseMetadata = {
    model:
      typeof response.model === 'string' && response.model.trim() !== ''
        ? response.model
        : null,
    requestId,
    usage:
      usage === null
        ? null
        : {
            inputTokens: tokens(usage.input_tokens),
            outputTokens: tokens(usage.output_tokens),
            totalTokens: tokens(usage.total_tokens),
          },
  };
  control.reportModelResponse?.(metadata);
  if (invalidUsage || metadata.model === null || response.object !== 'response')
    throw new ModelRequestError('invalid_response');
  if (response.status === 'incomplete') {
    const reason = object(response.incomplete_details).reason;
    throw new ModelRequestError(
      reason === 'max_output_tokens'
        ? 'output_truncated'
        : reason === 'content_filter'
          ? 'refused'
          : 'invalid_response',
    );
  }
  if (response.status === 'failed') {
    const code = object(response.error).code;
    throw new ModelRequestError(
      code === 'server_error'
        ? 'unavailable'
        : code === 'rate_limit_exceeded'
          ? 'rate_limited'
          : code === 'context_length_exceeded'
            ? 'input_limit'
            : 'request_failed',
    );
  }
  if (
    response.status !== 'completed' ||
    response.error != null ||
    response.incomplete_details != null ||
    !isJsonArray(response.output)
  )
    throw new ModelRequestError('invalid_response');
  const texts: string[] = [];
  for (const entry of response.output) {
    const item = object(entry);
    if (item.type === 'reasoning') continue;
    if (
      item.type !== 'message' ||
      item.role !== 'assistant' ||
      item.status !== 'completed' ||
      !isJsonArray(item.content)
    )
      throw new ModelRequestError('invalid_response');
    for (const value of item.content) {
      const content = object(value);
      if (content.type === 'refusal' && typeof content.refusal === 'string')
        throw new ModelRequestError('refused');
      if (content.type !== 'output_text' || typeof content.text !== 'string')
        throw new ModelRequestError('invalid_response');
      texts.push(content.text);
    }
  }
  if (texts.length !== 1) throw new ModelRequestError('invalid_response');
  try {
    return parseJsonValue(JSON.parse(texts[0]!), 'openai_output');
  } catch {
    throw new ModelRequestError('invalid_response');
  }
}
