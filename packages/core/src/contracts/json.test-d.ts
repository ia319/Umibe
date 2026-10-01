import { assertType } from 'vitest';
import type { JsonObject, JsonValue } from './json.js';

assertType<JsonValue>({
  nested: [null, { count: 3 }],
});

// @ts-expect-error Nested properties must also contain JSON values.
assertType<JsonValue>({ missing: undefined });
// @ts-expect-error JSON does not represent bigint values.
assertType<JsonValue>(1n);
// @ts-expect-error Dates require an explicit conversion to application data.
assertType<JsonValue>(new Date());

declare const object: JsonObject;
// @ts-expect-error A JSON object exposes a readonly view.
object.changed = true;

declare const array: Extract<JsonValue, readonly JsonValue[]>;
// @ts-expect-error A JSON array exposes a readonly view.
array[0] = 'changed';
