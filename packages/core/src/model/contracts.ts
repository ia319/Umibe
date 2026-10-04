import type { CallControl } from '#internal/contracts/control';
import type { JsonObject, JsonValue } from '#internal/contracts/json';
import type { ModelIdentity } from './metadata.js';

export interface StructuredOutputRequest {
  /** Trusted role instructions, separate from application-supplied input data. */
  readonly instructions: string;
  readonly input: JsonValue;
  readonly output: {
    readonly name: string;
    /** A strict JSON Schema with an object root and explicit required fields. */
    readonly schema: JsonObject;
  };
}

/**
 * A single non-streaming model request. Implementations perform no retries,
 * repairs, tools or fallback calls and forward response metadata before decoding.
 * Reject provider failures with ModelRequestError and caller cancellation with
 * AbortError. Direct callers own their budgets; Agent owns role attempt budgets.
 */
export interface StructuredOutputModel {
  readonly kind: 'structuredOutput';
  readonly identity: ModelIdentity;
  generate(
    request: StructuredOutputRequest,
    control: CallControl,
  ): Promise<JsonValue>;
}
