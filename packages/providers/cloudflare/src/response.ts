import {
  isJsonArray,
  isJsonObject,
  ModelRequestError,
} from '@umibe/core/model';
import type {
  CallControl,
  ChoiceResponse,
  JsonObject,
  JsonValue,
} from '@umibe/core/model';
import { cloudflareFailure, protocolFailure } from './errors.js';

function object(value: JsonValue | undefined, path: string): JsonObject {
  if (!isJsonObject(value)) throw protocolFailure(path, 'expected_object');
  return value;
}

/** Preserve trusted usage before validating answers; a malformed choice grants no action. */
export function decodeResponse(
  response: JsonValue,
  ids: readonly string[],
  requestId: string | null,
  headers: Headers,
  control: CallControl,
): ChoiceResponse {
  const envelope = object(response, '');
  if (typeof envelope.success !== 'boolean' || !isJsonArray(envelope.errors))
    throw protocolFailure('', 'invalid_envelope');
  if (!envelope.success) {
    if (
      envelope.errors.length === 0 ||
      !envelope.errors.every(
        (error) =>
          isJsonObject(error) &&
          typeof error.code === 'number' &&
          Number.isSafeInteger(error.code),
      )
    )
      throw protocolFailure('/errors', 'invalid_errors');
    throw cloudflareFailure(200, headers, envelope.errors);
  }
  if (envelope.errors.length !== 0)
    throw protocolFailure('/errors', 'unexpected_errors');
  const result = object(envelope.result, '/result');
  const usage = isJsonObject(result.usage) ? result.usage : null;
  let invalidUsage = usage === null;
  const tokens = (value: JsonValue | undefined): number | null => {
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
  const inputTokens = usage === null ? null : tokens(usage.input_tokens);
  const outputTokens = usage === null ? null : tokens(usage.output_tokens);
  const sum =
    inputTokens === null || outputTokens === null
      ? null
      : inputTokens + outputTokens;
  if (sum !== null && !Number.isSafeInteger(sum)) invalidUsage = true;
  const model =
    typeof result.model === 'string' && result.model.trim() !== ''
      ? result.model
      : null;
  control.reportModelResponse?.({
    model,
    requestId,
    usage:
      usage === null
        ? null
        : {
            inputTokens,
            outputTokens,
            totalTokens: sum !== null && Number.isSafeInteger(sum) ? sum : null,
          },
  });
  if (invalidUsage)
    throw protocolFailure('/result/usage', 'invalid_token_usage');
  if (model === null) throw protocolFailure('/result/model', 'missing_model');
  // Reference encoding trims state when the whole context fills its window.
  // Treat saturation as uncertain integrity even if the original input just fit.
  if (inputTokens !== null && inputTokens >= 65_536)
    throw new ModelRequestError('input_limit');
  const answers = object(result.answers, '/result/answers');
  if (Object.keys(answers).length !== 1 || !Object.hasOwn(answers, 'selection'))
    throw protocolFailure('/result/answers', 'question_mismatch');
  const answer = object(answers.selection, '/result/answers/selection');
  if (answer.type !== 'choice' || Object.keys(answer).length !== 4)
    throw protocolFailure('/result/answers/selection', 'invalid_choice_answer');
  if (typeof answer.choice !== 'string' || !ids.includes(answer.choice))
    throw protocolFailure('/result/answers/selection/choice', 'unknown_option');
  const probabilities = object(
    answer.probabilities,
    '/result/answers/selection/probabilities',
  );
  if (
    Object.keys(probabilities).length !== ids.length ||
    !ids.every((id) => Object.hasOwn(probabilities, id))
  )
    throw protocolFailure(
      '/result/answers/selection/probabilities',
      'option_mismatch',
    );
  let total = 0;
  let maximum = 0;
  const validated = ids.map((id) => {
    const value = probabilities[id];
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 1
    )
      throw protocolFailure(
        '/result/answers/selection/probabilities',
        'invalid_probability',
      );
    total += value;
    maximum = Math.max(maximum, value);
    return [id, value] as const;
  });
  if (Math.abs(total - 1) > 1e-6)
    throw protocolFailure(
      '/result/answers/selection/probabilities',
      'probability_sum',
    );
  const values = Object.freeze(Object.fromEntries(validated));
  if (maximum - values[answer.choice]! > 1e-6)
    throw protocolFailure(
      '/result/answers/selection/choice',
      'probability_rank',
    );
  if (
    typeof answer.confidence !== 'number' ||
    !Number.isFinite(answer.confidence) ||
    answer.confidence < 0 ||
    answer.confidence > 1
  )
    throw protocolFailure(
      '/result/answers/selection/confidence',
      'invalid_confidence',
    );
  return Object.freeze({
    optionId: answer.choice,
    probabilities: values,
    confidence: answer.confidence,
  });
}
