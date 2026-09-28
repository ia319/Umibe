import { ContractError } from '#internal/errors';
import type { JsonObject, JsonValue } from '#internal/contracts/json';

export function isJsonObject(
  value: JsonValue | undefined,
): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isJsonArray(
  value: JsonValue | undefined,
): value is readonly JsonValue[] {
  return Array.isArray(value);
}

type Container = Record<string, JsonValue> | JsonValue[];

type Task =
  | {
      readonly kind: 'visit';
      readonly input: unknown;
      readonly path: string;
      readonly assign: (value: JsonValue) => void;
    }
  | {
      readonly kind: 'finish';
      readonly source: object;
      readonly target: Container;
    };

export function jsonPointerChild(path: string, key: string): string {
  return `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

/** Copy and freeze JSON data after validating its complete runtime shape.
 * @param input - The untrusted value to validate and copy.
 * @param stage - The diagnostic boundary reported on invalid input.
 * @returns A detached, recursively frozen JSON value.
 * @throws ContractError with a JSON Pointer path when the input cannot be preserved as JSON data.
 */
export function parseJsonValue(input: unknown, stage: string): JsonValue {
  let result: JsonValue | undefined;
  const active = new Set<object>();
  const tasks: Task[] = [
    { kind: 'visit', input, path: '', assign: (value) => (result = value) },
  ];

  while (tasks.length > 0) {
    const task = tasks.pop();
    if (task === undefined) break;

    if (task.kind === 'finish') {
      Object.freeze(task.target);
      active.delete(task.source);
      continue;
    }

    const value = task.input;
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean'
    ) {
      task.assign(value);
      continue;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new ContractError(
          'INVALID_JSON',
          stage,
          task.path,
          'number_not_finite',
        );
      }
      task.assign(value);
      continue;
    }
    if (typeof value !== 'object') {
      throw new ContractError(
        'INVALID_JSON',
        stage,
        task.path,
        'unsupported_type',
      );
    }
    if (active.has(value)) {
      throw new ContractError(
        'INVALID_JSON',
        stage,
        task.path,
        'circular_reference',
      );
    }

    try {
      if (Array.isArray(value)) {
        const source: unknown[] = value;
        const keys = Reflect.ownKeys(source);
        const length = source.length;
        if (keys.length !== length + 1) {
          throw new ContractError(
            'INVALID_JSON',
            stage,
            task.path,
            'sparse_or_extended_array',
          );
        }
        const target: JsonValue[] = new Array<JsonValue>(length);
        task.assign(target);
        active.add(value);
        tasks.push({ kind: 'finish', source: value, target });
        for (let index = length - 1; index >= 0; index -= 1) {
          const descriptor = Object.getOwnPropertyDescriptor(source, index);
          if (descriptor === undefined || !('value' in descriptor)) {
            throw new ContractError(
              'INVALID_JSON',
              stage,
              jsonPointerChild(task.path, String(index)),
              'missing_or_accessor_value',
            );
          }
          tasks.push({
            kind: 'visit',
            input: descriptor.value as unknown,
            path: jsonPointerChild(task.path, String(index)),
            assign: (item) => (target[index] = item),
          });
        }
        continue;
      }

      const prototype: unknown = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new ContractError(
          'INVALID_JSON',
          stage,
          task.path,
          'non_plain_object',
        );
      }
      const target: Record<string, JsonValue> = {};
      const keys = Reflect.ownKeys(value);
      task.assign(target);
      active.add(value);
      tasks.push({ kind: 'finish', source: value, target });
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index];
        if (typeof key !== 'string') {
          throw new ContractError(
            'INVALID_JSON',
            stage,
            task.path,
            'symbol_key',
          );
        }
        const path = jsonPointerChild(task.path, key);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !('value' in descriptor)
        ) {
          throw new ContractError(
            'INVALID_JSON',
            stage,
            path,
            'hidden_or_accessor_property',
          );
        }
        tasks.push({
          kind: 'visit',
          input: descriptor.value as unknown,
          path,
          assign: (item) =>
            Object.defineProperty(target, key, {
              value: item,
              enumerable: true,
              writable: true,
              configurable: true,
            }),
        });
      }
    } catch (error) {
      if (error instanceof ContractError) throw error;
      throw new ContractError(
        'INVALID_JSON',
        stage,
        task.path,
        'property_inspection_failed',
      );
    }
  }

  if (result === undefined) {
    throw new ContractError('INVALID_JSON', stage, '', 'unsupported_type');
  }
  return result;
}
