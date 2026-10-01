import type { JsonValue } from './json.js';

export type ObservationFact =
  | { readonly status: 'known'; readonly value: JsonValue }
  | { readonly status: 'absent' }
  | { readonly status: 'unknown'; readonly reason: string }
  | { readonly status: 'unobserved' }
  | {
      readonly status: 'stale';
      readonly lastKnown: JsonValue;
      readonly lastObservedAt: string;
    };

/** Scope and completeness are application claims, not inferred from missing keys. */
export interface ObservationCoverage {
  readonly scope: string;
  readonly completeness: 'complete' | 'partial';
  readonly uncheckedScopes: readonly string[];
}

export interface Observation {
  readonly runId: string;
  readonly id: string;
  readonly revision: number;
  /** Canonical UTC timestamp with millisecond precision. */
  readonly observedAt: string;
  readonly source: string;
  readonly coverage: ObservationCoverage;
  readonly data: Readonly<Record<string, ObservationFact>>;
}
