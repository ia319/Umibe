import type { z } from 'zod';
import type {
  ActionCapability,
  FixedActionCall,
  ParameterChange,
} from '#internal/contracts/action';
import type { ParameterSource } from '#internal/contracts/candidate';
import type { JsonObject, JsonValue } from '#internal/contracts/json';
import { ContractError } from '#internal/errors';
import { requireObject } from '#internal/validation/fields';
import type { FieldContext } from '#internal/validation/fields';
import {
  isJsonArray,
  isJsonObject,
  jsonPointerChild,
  parseJsonValue,
} from '#internal/validation/json';
import { readParameterSources } from '#internal/validation/parameter-sources';

const context: FieldContext = {
  code: 'INVALID_ACTION_PARAMETERS',
  stage: 'action_parameters',
};

export function assertPreservedParameterKeys(
  value: JsonValue,
  context: FieldContext,
  path: string,
): void {
  const pending = [{ value, path }];
  while (pending.length > 0) {
    const item = pending.pop()!;
    if (item.value === null || typeof item.value !== 'object') continue;
    for (const [key, child] of Object.entries(item.value)) {
      const childPath = jsonPointerChild(item.path, key);
      // Zod 4 discards __proto__ in object and record parsers, even when declared.
      // Reject it rather than hand a callback a value that contradicts its schema type.
      if (key === '__proto__') {
        throw new ContractError(
          context.code,
          context.stage,
          childPath,
          'unpreserved_parameter_key',
        );
      }
      pending.push({ value: child, path: childPath });
    }
  }
}

function collectParameterChanges(
  input: JsonObject,
  output: JsonObject,
): readonly ParameterChange[] {
  const changes: ParameterChange[] = [];
  const pending: {
    before: JsonValue | undefined;
    after: JsonValue | undefined;
    path: string;
  }[] = [{ before: input, after: output, path: '' }];

  while (pending.length > 0) {
    const { before, after, path } = pending.pop()!;
    if (before === after) continue;
    if (before === undefined || after === undefined) {
      changes.push(
        Object.freeze({
          kind: before === undefined ? 'added' : 'removed',
          path,
        }),
      );
    } else if (isJsonArray(before) && isJsonArray(after)) {
      for (
        let index = Math.max(before.length, after.length) - 1;
        index >= 0;
        index -= 1
      ) {
        pending.push({
          before: before[index],
          after: after[index],
          path: jsonPointerChild(path, String(index)),
        });
      }
    } else if (isJsonObject(before) && isJsonObject(after)) {
      const keys = [
        ...new Set([...Object.keys(before), ...Object.keys(after)]),
      ].sort();
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index]!;
        pending.push({
          before: before[key],
          after: after[key],
          path: jsonPointerChild(path, key),
        });
      }
    } else {
      changes.push(Object.freeze({ kind: 'changed', path }));
    }
  }
  return Object.freeze(changes);
}

export async function normalizeActionParameters<TSchema extends z.ZodObject>(
  parameters: TSchema,
  capability: ActionCapability,
  input: JsonObject,
  sources: JsonValue | undefined,
): Promise<{
  readonly call: FixedActionCall;
  readonly params: z.output<TSchema>;
}> {
  const inputSources = readParameterSources(
    sources,
    input,
    context,
    '/paramSources',
  );
  assertPreservedParameterKeys(input, context, '/params');
  let parsed: z.ZodSafeParseResult<z.output<TSchema>>;
  try {
    parsed = await parameters.safeParseAsync(input);
  } catch {
    throw new ContractError(
      context.code,
      context.stage,
      '/params',
      'parameter_schema_failed',
    );
  }
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = (issue?.path ?? []).reduce<string>(
      (path, key) => jsonPointerChild(path, String(key)),
      '/params',
    );
    throw new ContractError(
      context.code,
      context.stage,
      path,
      `schema_${issue?.code ?? 'invalid'}`,
    );
  }

  const outputContext: FieldContext = {
    ...context,
    stage: 'action_parameters_output',
  };
  const envelope = requireObject(
    parseJsonValue({ params: parsed.data }, outputContext.stage),
    outputContext,
    '',
  );
  const params = requireObject(envelope.params, outputContext, '/params');
  assertPreservedParameterKeys(params, outputContext, '/params');
  const paramSources = Object.create(null) as Record<string, ParameterSource>;
  const properties = capability.parameters.properties;
  for (const key of Object.keys(params)) {
    if (Object.hasOwn(input, key)) {
      paramSources[key] = inputSources[key]!;
    } else {
      const field = isJsonObject(properties) ? properties[key] : undefined;
      // An omitted field produced by a transform has no supplied source. Only
      // an explicit schema default can justify labelling that value as defaulted.
      if (!isJsonObject(field) || !Object.hasOwn(field, 'default')) {
        throw new ContractError(
          context.code,
          context.stage,
          jsonPointerChild('/paramSources', key),
          'added_parameter_without_default',
        );
      }
      paramSources[key] = Object.freeze({
        kind: 'default',
        reference: `action:${encodeURIComponent(capability.id)}@${capability.version}#${jsonPointerChild('/properties', key)}`,
      });
    }
  }
  const call: FixedActionCall = Object.freeze({
    actionId: capability.id,
    actionVersion: capability.version,
    params,
    paramSources: readParameterSources(
      parseJsonValue(paramSources, context.stage),
      params,
      context,
      '/paramSources',
    ),
    parameterChanges: collectParameterChanges(input, params),
  });
  // The JSON boundary copies values already parsed as TSchema's output without
  // coercing them. Retain that proven type for the bound callbacks, not raw input.
  return { call, params: params as z.output<TSchema> };
}
