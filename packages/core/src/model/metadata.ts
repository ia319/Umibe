/** Public model identifiers only. Never include credentials or endpoint URLs. */
export interface ModelIdentity {
  readonly provider: string;
  readonly model: string;
}

/** Token counts are nonnegative safe integers; null means unknown, not zero. */
export interface ModelUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
}

/** Metadata from one response, including refusals and incomplete output. */
export interface ModelResponseMetadata {
  /** The actual model reported by the service; null if unavailable. */
  readonly model: string | null;
  readonly requestId: string | null;
  readonly usage: ModelUsage | null;
}

/** Native choice evidence and its locally bound candidate mapping; never execution authority. */
export interface ModelChoiceMetadata {
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

/** Safe output diagnostics only: field paths and reason codes, never rejected values. */
export interface ModelResponseIssue {
  readonly phase: 'protocol' | 'planning' | 'selection';
  /** JSON Pointer with ASCII letters, digits, underscores or hyphens; at most 256 characters. */
  readonly path: string;
  /** Lowercase snake_case code beginning with a letter; at most 64 characters. */
  readonly reason: string;
}
