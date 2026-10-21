import {
  isJsonArray,
  isJsonObject,
  parseJsonValue,
  ModelRequestError,
} from '@umibe/core/model';
import type { ChoiceRequest, JsonObject } from '@umibe/core/model';

/** Validate the native protocol and capture the exact option IDs before awaiting HTTP. */
export function encodeRequest(
  request: ChoiceRequest,
  model: string,
  parameters: JsonObject,
  maxRequestBytes: number,
): { body: string; ids: readonly string[] } {
  let body: string;
  let ids: string[];
  try {
    const input = parseJsonValue(request.input, 'clef_state');
    const state = typeof input === 'string' ? input : JSON.stringify(input);
    const instructions = parseJsonValue(request.instructions, 'clef_question');
    if (
      !(typeof instructions === 'string'
        ? instructions.trim() !== ''
        : isJsonObject(instructions) || isJsonArray(instructions))
    )
      throw new ModelRequestError('invalid_request');
    const options = parseJsonValue(request.options, 'clef_options');
    if (!isJsonArray(options) || options.length < 2 || options.length > 255)
      throw new ModelRequestError('invalid_request');
    ids = [];
    const entries = options.map((option) => {
      if (
        !isJsonObject(option) ||
        typeof option.id !== 'string' ||
        option.id.trim() === '' ||
        ids.includes(option.id)
      )
        throw new ModelRequestError('invalid_request');
      ids.push(option.id);
      const description = parseJsonValue(option.description, 'clef_option');
      if (typeof description === 'number' || typeof description === 'boolean')
        throw new ModelRequestError('invalid_request');
      return [option.id, description] as const;
    });
    body = JSON.stringify({
      model,
      ...parameters,
      state,
      questions: {
        selection: {
          type: 'choice',
          instructions,
          criteria: Object.fromEntries(entries),
        },
      },
    });
  } catch {
    throw new ModelRequestError('invalid_request');
  }
  if (Buffer.byteLength(body, 'utf8') > maxRequestBytes)
    throw new ModelRequestError('input_limit');
  return { body, ids: Object.freeze(ids) };
}
