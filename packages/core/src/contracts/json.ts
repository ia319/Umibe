/** TypeScript also accepts NaN and infinities; validate finite numbers at runtime. */
export type JsonPrimitive = string | number | boolean | null;

export type JsonObject = {
  readonly [key: string]: JsonValue;
};

/** Readonly types neither validate JSON data nor freeze the underlying values. */
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
