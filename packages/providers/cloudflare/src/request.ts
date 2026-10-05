import {
  isJsonArray,
  isJsonObject,
  parseJsonValue,
  ModelRequestError,
} from '@umibe/core/model';
import type { ChoiceRequest } from '@umibe/core/model';

/** Validate the native protocol and capture the exact option IDs before awaiting HTTP. */
export function encodeRequest(
  request: ChoiceRequest,
  maxRequestBytes: number,
): { body: string; ids: readonly string[] } {
  let state: string;
  let body: string;
  let ids: string[];
  try {
    const input = parseJsonValue(request.input, 'clef_state');
    state = typeof input === 'string' ? input : JSON.stringify(input);
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
      model: 'clef',
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
  // The hosted API capped state at 2048 tokens in 2026-10-05 probes. UTF-8
  // bytes conservatively bound the reference Qwen2 byte-level tokenization;
  // this is an input integrity guard, not a token usage estimate. See
  // https://huggingface.co/Cloudflare/clef/blob/main/joint_schema_model.py
  if (
    Buffer.byteLength(state, 'utf8') > 2048 ||
    Buffer.byteLength(body, 'utf8') > maxRequestBytes
  )
    throw new ModelRequestError('input_limit');
  return { body, ids: Object.freeze(ids) };
}
