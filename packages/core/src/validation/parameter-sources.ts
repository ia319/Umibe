import type { ParameterSource } from '#internal/contracts/candidate';
import type { JsonObject, JsonValue } from '#internal/contracts/json';
import { ContractError } from '#internal/errors';
import { requireKeys, requireObject, requireString } from './fields.js';
import type { FieldContext } from './fields.js';
import { jsonPointerChild } from './json.js';

/** Keep proposal and normalized-call provenance subject to the same key invariant. */
export function readParameterSources(
  value: JsonValue | undefined,
  params: JsonObject,
  context: FieldContext,
  path: string,
): Readonly<Record<string, ParameterSource>> {
  const object = requireObject(value, context, path);
  if (
    Object.keys(object).length !== Object.keys(params).length ||
    Object.keys(params).some((key) => !Object.hasOwn(object, key))
  ) {
    throw new ContractError(
      context.code,
      context.stage,
      path,
      'parameter_source_mismatch',
    );
  }
  const sources = Object.create(null) as Record<string, ParameterSource>;
  for (const [key, entry] of Object.entries(object)) {
    const sourcePath = jsonPointerChild(path, key);
    const record = requireObject(entry, context, sourcePath);
    requireKeys(record, ['kind', 'reference'], context, sourcePath);
    const kind = record.kind;
    if (
      kind !== 'observation' &&
      kind !== 'application' &&
      kind !== 'model' &&
      kind !== 'default'
    ) {
      throw new ContractError(
        context.code,
        context.stage,
        `${sourcePath}/kind`,
        'invalid_parameter_source',
      );
    }
    sources[key] = Object.freeze({
      kind,
      reference: requireString(
        record.reference,
        context,
        `${sourcePath}/reference`,
      ),
    });
  }
  return Object.freeze(sources);
}
