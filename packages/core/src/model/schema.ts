import type { JsonObject } from '#internal/contracts/json';

/** Every object field is required; nullable fields represent optional business values. */
export function strictObjectSchema(
  properties: Readonly<Record<string, JsonObject>>,
): JsonObject {
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}
