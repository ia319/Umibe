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

export interface ChoiceOption {
  /** Unique, nonempty ID; implementations preserve it exactly. */
  readonly id: string;
  readonly description: JsonValue;
}

export interface ChoiceRequest {
  /** The question, optionally accompanied by referenced data rather than trusted instructions. */
  readonly instructions: string | JsonObject | readonly JsonValue[];
  /** The state to evaluate. Model implementations must reject input they cannot preserve. */
  readonly input: JsonValue;
  /** At least two distinct options; no option may be removed or rewritten. */
  readonly options: readonly ChoiceOption[];
}

export interface ChoiceResponse {
  readonly optionId: string;
  /** When supplied, include every requested option with a finite value in [0, 1]. */
  readonly probabilities?: Readonly<Record<string, number>>;
  /** A provider-specific value in [0, 1], not an action success probability. */
  readonly confidence?: number;
}

/**
 * One native choice request with the same cancellation, failure and single-attempt
 * obligations as StructuredOutputModel. Probabilities are optional; their sum,
 * ranking and precision remain provider protocol rules.
 */
export interface ChoiceModel {
  readonly kind: 'choice';
  readonly identity: ModelIdentity;
  /** Maximum API options, including abstention; a safe integer of at least two. */
  readonly maxOptions?: number;
  choose(request: ChoiceRequest, control: CallControl): Promise<ChoiceResponse>;
}
