import type { JsonValue } from '#internal/contracts/json';

/** Public model identifiers only. Never include credentials or endpoint URLs. */
export interface ModelIdentity {
  readonly provider: string;
  readonly model: string;
}

/** The serialized JSON sent to a provider, excluding authentication and headers. */
export interface ModelRequestRecord {
  readonly protocol: 'http' | 'jsonRpc';
  /** HTTP method or JSON-RPC method, as sent. */
  readonly method: string;
  readonly body: string;
}

/** Source facts and the exact role projection before provider-specific conversion. */
export interface ModelProjectionRecord {
  readonly role: 'planning' | 'selection' | 'decision';
  readonly version: 1;
  /** Complete captured role request; retained IDs join projected choices and evidence. */
  readonly source: JsonValue;
  readonly request: JsonValue;
}

/** Raw provider bytes, recorded independently from decoding and acceptance. */
export interface ModelResponseRecord {
  readonly protocol: 'http' | 'jsonRpc';
  readonly method: string;
  readonly body: string;
  /** Base64 preserves arbitrary bytes; UTF-8 is valid only after strict decoding. */
  readonly encoding: 'utf8' | 'base64';
  /** False retains the received prefix when transport or a response limit ends reading. */
  readonly complete: boolean;
  /** HTTP status, or null for JSON-RPC. */
  readonly status: number | null;
}

/** Token counts are nonnegative safe integers; null means unknown, not zero. */
export interface ModelUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
}

/** Metadata for one provider invocation, including aggregate task usage when available. */
export interface ModelResponseMetadata {
  /** The actual model reported by the service; null if unavailable. */
  readonly model: string | null;
  readonly requestId: string | null;
  readonly usage: ModelUsage | null;
}

/** Native choice evidence and its local bindings; never execution authority. */
export type ModelChoiceMetadata =
  SelectionModelChoiceMetadata | DecisionModelChoiceMetadata;

export interface SelectionModelChoiceMetadata {
  readonly kind: 'selection';
  readonly candidateSetId: string;
  readonly optionId: string;
  readonly options: readonly {
    readonly id: string;
    /** Null identifies the abstention option. */
    readonly candidateId: string | null;
    /** Null means the model did not provide a probability. */
    readonly probability: number | null;
  }[];
  /** Provider-specific certainty, or null when unavailable. */
  readonly confidence: number | null;
}

export interface DecisionModelChoiceMetadata {
  readonly kind: 'decision';
  /** Joins the fixed option meanings in the recorded DecisionRequest. */
  readonly requestId: string;
  readonly optionId: string;
  readonly options: readonly {
    /** Exact offered DecisionOption ID, including any explicit abstention choice. */
    readonly id: string;
    /** Null means the model did not provide a probability. */
    readonly probability: number | null;
  }[];
  /** Provider-specific certainty, or null when unavailable. */
  readonly confidence: number | null;
}

/** Safe output diagnostics only: field paths and reason codes, never rejected values. */
export interface ModelResponseIssue {
  readonly phase: 'protocol' | 'decision' | 'planning' | 'selection';
  /** JSON Pointer with ASCII letters, digits, underscores or hyphens; at most 256 characters. */
  readonly path: string;
  /** Lowercase snake_case code beginning with a letter; at most 64 characters. */
  readonly reason: string;
}
