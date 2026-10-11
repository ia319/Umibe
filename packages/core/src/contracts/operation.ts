import type { ParameterSource } from './candidate.js';

export type OperationAvailability =
  | { readonly status: 'available' }
  | {
      readonly status: 'unavailable' | 'unknown';
      readonly reason: string;
    };

/** Availability and parameter provenance for one registered action, without bound arguments. */
export interface OperationOffer {
  /** The registered action ID; operations do not create a second action registry. */
  readonly operationId: string;
  readonly actionVersion: number;
  readonly availability: OperationAvailability;
  readonly parameterSources: Readonly<Record<string, ParameterSource>>;
  readonly informationGaps: readonly string[];
}

/** Preserve all listed operations, including unavailable and unknown entries. */
export interface OperationSet {
  readonly id: string;
  readonly requestId: string;
  readonly operations: readonly OperationOffer[];
  readonly informationGaps: readonly string[];
  readonly capabilityGaps: readonly string[];
}
