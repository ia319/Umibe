import { z } from 'zod';
import type { JsonObject } from '../contracts/json.js';
import { ContractError } from '../errors.js';
import { isJsonObject, parseJsonValue } from '../validation/json.js';

/** Export accepted parameter input for providers; runtime parsing remains authoritative.
 * @param parameters - An action's object schema with deterministic, side-effect-free defaults.
 * @returns A detached JSON description safe to send to an adapter.
 * @throws ContractError if the schema cannot be represented as JSON data.
 */
export function describeActionParameters(parameters: z.ZodObject): JsonObject {
  let description: unknown;
  try {
    // Zod can evaluate default factories while producing their JSON annotations.
    description = z.toJSONSchema(parameters, {
      io: 'input',
      unrepresentable: 'throw',
    });
  } catch {
    throw new ContractError(
      'INVALID_ACTION_DEFINITION',
      'action_definition',
      '/parameters',
      'unrepresentable_parameters',
    );
  }
  // Zod attaches non-enumerable metadata to its export; only JSON data crosses the adapter boundary.
  const json = parseJsonValue(
    JSON.parse(JSON.stringify(description)) as unknown,
    'action_definition',
  );
  if (!isJsonObject(json)) {
    throw new ContractError(
      'INVALID_ACTION_DEFINITION',
      'action_definition',
      '/parameters',
      'expected_object_schema',
    );
  }
  return json;
}
