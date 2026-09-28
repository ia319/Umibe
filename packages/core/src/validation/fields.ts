import { ContractError } from '#internal/errors';
import type { ContractErrorCode } from '#internal/errors';
import type { JsonObject, JsonValue } from '#internal/contracts/json';
import { isJsonObject, jsonPointerChild } from './json.js';

export interface FieldContext {
  readonly code: ContractErrorCode;
  readonly stage: string;
}

export function requireObject(
  value: JsonValue | undefined,
  context: FieldContext,
  path: string,
): JsonObject {
  if (!isJsonObject(value)) {
    throw new ContractError(
      context.code,
      context.stage,
      path,
      'expected_object',
    );
  }
  return value;
}

export function requireString(
  value: JsonValue | undefined,
  context: FieldContext,
  path: string,
): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ContractError(
      context.code,
      context.stage,
      path,
      'expected_nonempty_string',
    );
  }
  return value;
}

export function requireInteger(
  value: JsonValue | undefined,
  minimum: 0 | 1,
  context: FieldContext,
  path: string,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    throw new ContractError(
      context.code,
      context.stage,
      path,
      'expected_integer',
    );
  }
  return value;
}

/** Timestamps use the canonical millisecond UTC form produced by Date#toISOString. */
export function requireTimestamp(
  value: JsonValue | undefined,
  context: FieldContext,
  path: string,
): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new ContractError(
      context.code,
      context.stage,
      path,
      'expected_utc_timestamp',
    );
  }
  return value;
}

/** Reject unsupported fields instead of silently accepting control metadata. */
export function requireKeys(
  object: JsonObject,
  names: readonly string[],
  context: FieldContext,
  path: string,
): void {
  const allowed = new Set(names);
  for (const name of Object.keys(object)) {
    if (!allowed.has(name)) {
      throw new ContractError(
        context.code,
        context.stage,
        jsonPointerChild(path, name),
        'unknown_field',
      );
    }
  }
  for (const name of names) {
    if (!Object.hasOwn(object, name)) {
      throw new ContractError(
        context.code,
        context.stage,
        jsonPointerChild(path, name),
        'missing_field',
      );
    }
  }
}
